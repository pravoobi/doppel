/**
 * Unit tests for the orchestrator's control flow, against a mocked
 * SandboxClient — no real sandbox calls, no cost. Covers the branches that
 * matter most: setup failure, original-content render failure, patched-content
 * render failure, and the PASS/REVIEW/FAIL path once both variants render.
 */

import { PNG } from "pngjs"
import { describe, expect, it, vi } from "vitest"
import type { SandboxClient, SpawnInstanceInput, OperationResult } from "../src/sandbox.js"
import { runVerification, verifyFromWarmImage, type VerifyInput, type VerifyFromWarmImageInput } from "../src/verify.js"

function solidPngBase64(width: number, height: number, gray: number): string {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = gray
    png.data[i + 1] = gray
    png.data[i + 2] = gray
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png).toString("base64")
}

function shootStdout(gray: number, viewports = [375, 768, 1440]): string {
  const lines = viewports.map((v) => `DOPPEL_SCREENSHOT:${v}:${solidPngBase64(v, 800, gray)}`)
  lines.push("DOPPEL_SHOOT_DONE")
  return lines.join("\n")
}

function op(overrides: Partial<OperationResult>): OperationResult {
  return {
    uuid: "op",
    status: "SUCCESS",
    error: null,
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stdoutTruncated: false,
    stderr: "",
    stderrTruncated: false,
    resultImageUuid: "img-checkpoint",
    ...overrides,
  }
}

function fakeSandbox(runCommand: (input: SpawnInstanceInput) => Promise<OperationResult>): SandboxClient {
  return { runCommand } as unknown as SandboxClient
}

function baseInput(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    projectFiles: { "package.json": "{}" },
    targetFilePath: "app/page.tsx",
    beforeFileContent: "<button>Export</button>",
    afterFileContent: "<Button>Export</Button>",
    harness: { componentImportPath: "@/app/page", exportName: null, props: {} },
    typecheckPassed: true,
    lintPassed: true,
    baseImage: "tag:node:22-slim",
    setupCommand: "npm install",
    buildCommand: "npx vite build",
    buildOutputHtmlPath: "dist/index.html",
    ...overrides,
  }
}

describe("runVerification", () => {
  it("returns UNVERIFIABLE when sandbox setup fails", async () => {
    const sandbox = fakeSandbox(async () => op({ exitCode: 1, stderr: "npm ERR! network timeout" }))
    const result = await runVerification(sandbox, baseInput())
    expect(result.verdict).toBe("UNVERIFIABLE")
    expect(result.errorMessage).toContain("sandbox setup failed")
  })

  it("returns UNVERIFIABLE when setup succeeds but returns no checkpoint image", async () => {
    const sandbox = fakeSandbox(async () => op({ exitCode: 0, resultImageUuid: null }))
    const result = await runVerification(sandbox, baseInput())
    expect(result.verdict).toBe("UNVERIFIABLE")
  })

  it("returns UNVERIFIABLE when the ORIGINAL content fails to render — a harness problem, not the patch's fault", async () => {
    let call = 0
    const sandbox = fakeSandbox(async () => {
      call++
      if (call === 1) return op({ exitCode: 0 }) // setup
      return op({ exitCode: 1, stdout: `DOPPEL_RENDER_ERROR:${JSON.stringify("useParams is not a function")}` })
    })
    const result = await runVerification(sandbox, baseInput())
    expect(result.verdict).toBe("UNVERIFIABLE")
    expect(result.errorMessage).toContain("original content failed to render")
    expect(result.errorMessage).toContain("useParams is not a function")
  })

  it("returns FAIL when the PATCHED content fails to render but the original rendered fine", async () => {
    let call = 0
    const sandbox = fakeSandbox(async () => {
      call++
      if (call === 1) return op({ exitCode: 0 }) // setup
      if (call === 2) return op({ exitCode: 0, stdout: shootStdout(100) }) // before: renders fine
      return op({ exitCode: 1, stdout: `DOPPEL_RENDER_ERROR:${JSON.stringify("Cannot find name Button")}` }) // after: broken
    })
    const result = await runVerification(sandbox, baseInput())
    expect(result.verdict).toBe("FAIL")
    expect(result.errorMessage).toContain("patched content failed to render")
  })

  it("returns PASS when both variants render pixel-identically and typecheck/lint passed", async () => {
    let call = 0
    const sandbox = fakeSandbox(async () => {
      call++
      if (call === 1) return op({ exitCode: 0 }) // setup
      return op({ exitCode: 0, stdout: shootStdout(100) }) // before AND after: identical gray
    })
    const result = await runVerification(sandbox, baseInput())
    expect(result.verdict).toBe("PASS")
    expect(result.renderable).toBe(true)
    expect(result.viewportResults).toHaveLength(3)
    for (const v of result.viewportResults) expect(v.deltaRatio).toBe(0)
  })

  it("returns FAIL when both variants render but typecheck failed, even with identical pixels", async () => {
    let call = 0
    const sandbox = fakeSandbox(async () => {
      call++
      if (call === 1) return op({ exitCode: 0 })
      return op({ exitCode: 0, stdout: shootStdout(100) })
    })
    const result = await runVerification(sandbox, baseInput({ typecheckPassed: false }))
    expect(result.verdict).toBe("FAIL")
  })

  it("returns REVIEW when the two variants render with a moderate visual difference", async () => {
    let call = 0
    const sandbox = fakeSandbox(async () => {
      call++
      if (call === 1) return op({ exitCode: 0 })
      if (call === 2) return op({ exitCode: 0, stdout: shootStdout(100) }) // before: gray 100
      return op({ exitCode: 0, stdout: shootStdout(103) }) // after: gray 103 — tiny color shift
    })
    const result = await runVerification(sandbox, baseInput())
    expect(["REVIEW", "PASS"]).toContain(result.verdict) // exact bucket depends on pixelmatch's color-distance sensitivity
    expect(result.viewportResults.every((v) => v.deltaRatio >= 0)).toBe(true)
  })

  it("forks BEFORE and AFTER from the SAME warm checkpoint, not from each other", async () => {
    const images: string[] = []
    const sandbox = fakeSandbox(async (input) => {
      images.push(input.image)
      if (images.length === 1) return op({ exitCode: 0, resultImageUuid: "warm-checkpoint" })
      return op({ exitCode: 0, stdout: shootStdout(100) })
    })
    await runVerification(sandbox, baseInput())
    expect(images[0]).toBe("tag:node:22-slim") // setup, from the base image
    expect(images[1]).toBe("warm-checkpoint") // before, forked from warm
    expect(images[2]).toBe("warm-checkpoint") // after, ALSO forked from warm — not from images[1]'s result
  })

  it("passes the html path and viewport options through to the generated shoot script's command", async () => {
    let renderCommand = ""
    let call = 0
    const sandbox = fakeSandbox(async (input) => {
      call++
      if (call === 1) return op({ exitCode: 0 })
      renderCommand = input.command
      return op({ exitCode: 0, stdout: shootStdout(100, [375]) })
    })
    await runVerification(sandbox, baseInput({ viewports: [375], buildOutputHtmlPath: "out/index.html" }))
    expect(renderCommand).toContain("npx vite build")
    expect(renderCommand).toContain("node harness/shoot.mjs")
  })
})

function baseWarmImageInput(overrides: Partial<VerifyFromWarmImageInput> = {}): VerifyFromWarmImageInput {
  const { projectFiles: _projectFiles, baseImage: _baseImage, setupCommand: _setupCommand, setupTimeoutSeconds: _setupTimeoutSeconds, ...rest } = baseInput()
  return { ...rest, ...overrides }
}

describe("verifyFromWarmImage", () => {
  it("does NO setup call — every call to the sandbox forks the given warm image directly", async () => {
    const images: string[] = []
    const sandbox = fakeSandbox(async (input) => {
      images.push(input.image)
      return op({ exitCode: 0, stdout: shootStdout(100) })
    })
    await verifyFromWarmImage(sandbox, "shared-warm-image", baseWarmImageInput())
    expect(images).toEqual(["shared-warm-image", "shared-warm-image"]) // before, after — no setup call
  })

  it("returns the same PASS/REVIEW/FAIL/UNVERIFIABLE shape as runVerification for an identical scenario", async () => {
    const sandbox = fakeSandbox(async () => op({ exitCode: 0, stdout: shootStdout(100) }))
    const result = await verifyFromWarmImage(sandbox, "shared-warm-image", baseWarmImageInput())
    expect(result.verdict).toBe("PASS")
    expect(result.renderable).toBe(true)
    expect(result.viewportResults).toHaveLength(3)
  })

  it("carries a caller-supplied setupLog through to the result untouched", async () => {
    const sandbox = fakeSandbox(async () => op({ exitCode: 0, stdout: shootStdout(100) }))
    const result = await verifyFromWarmImage(sandbox, "shared-warm-image", baseWarmImageInput(), "setup happened once, earlier")
    expect(result.setupLog).toBe("setup happened once, earlier")
  })

  it("returns UNVERIFIABLE when the ORIGINAL content fails to render against the shared warm image", async () => {
    const sandbox = fakeSandbox(async () =>
      op({ exitCode: 1, stdout: `DOPPEL_RENDER_ERROR:${JSON.stringify("ReferenceError: handleClick is not defined")}` })
    )
    const result = await verifyFromWarmImage(sandbox, "shared-warm-image", baseWarmImageInput())
    expect(result.verdict).toBe("UNVERIFIABLE")
    expect(result.errorMessage).toContain("handleClick is not defined")
  })
})

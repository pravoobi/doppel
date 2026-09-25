/**
 * The M3 orchestrator (CLAUDE.md §5.7): wires harness generation, sandbox
 * execution, screenshot capture, pixel diffing, and verdict computation into
 * one end-to-end run. Implements §3.3's "fork per patch from a warm base"
 * literally, using the image-checkpoint chaining confirmed live (see
 * docs/DECISIONS.md): setup once, then fork the SAME warm checkpoint twice —
 * once to render the original file content, once for the patched content —
 * rather than paying install cost twice or letting the two renders share
 * mutated state.
 *
 * `verifyFromWarmImage` is the same fork-twice-and-diff core split out so a
 * caller verifying MANY candidates in one run (apps/web/lib/pipeline.ts) can
 * build ONE warm image (with npm install + Playwright done once) and reuse it
 * across every candidate — §3.3 point 1's "one custom image... every
 * verification forks from that image," not one `npm install` per candidate.
 * `runVerification` is just `verifyFromWarmImage` plus a one-off setup call,
 * kept as the single-candidate entry point `scripts/m3-pipeline.ts` uses.
 */

import { diffPngBuffers } from "./diff"
import { buildWriteFilesCommand, prefixFiles, type FileSet } from "./files"
import { generateHarness, type HarnessInput } from "./harness"
import type { SandboxClient } from "./sandbox"
import { generateShootScript, parseShootOutput, VIEWPORTS, type ShootResult } from "./shoot"
import { computeVerdict, loadThresholdsFromEnv, type Thresholds } from "./verdict"
import type { Verdict } from "@doppel/shared"

export type VerifyFromWarmImageInput = {
  /** Path (relative to the sandbox working directory) of the file containing the candidate. */
  targetFilePath: string
  beforeFileContent: string
  afterFileContent: string
  harness: HarnessInput
  /** Already computed by the caller's typecheck/lint pass (e.g. scripts/m2-pipeline.ts's flow). */
  typecheckPassed: boolean
  lintPassed: boolean
  /** Repo-specific build command producing a static site, e.g. "npx vite build". */
  buildCommand: string
  /** Where the build command's output HTML lands, relative to cwd, e.g. "dist/index.html". */
  buildOutputHtmlPath: string
  viewports?: readonly number[]
  darkMode?: boolean
  renderTimeoutSeconds?: number
  thresholds?: Thresholds
}

export type VerifyInput = VerifyFromWarmImageInput & {
  /**
   * Every file the render needs EXCEPT the target file and the harness itself
   * (both added automatically) — DS component files, lib/utils, tailwind
   * config + globals.css, package.json, tsconfig, etc.
   */
  projectFiles: FileSet
  /** e.g. "tag:node:22-slim". No pre-baked warm image with deps exists yet — see docs/DECISIONS.md. */
  baseImage: string
  /** Repo-specific install command, e.g. "npm install && npx playwright install --with-deps chromium". */
  setupCommand: string
  setupTimeoutSeconds?: number
}

export type VerifyViewportResult = {
  viewport: number
  deltaRatio: number
  beforePng: Buffer
  afterPng: Buffer
  diffPng: Buffer
}

export type VerifyResult = {
  verdict: Verdict
  renderable: boolean
  errorMessage?: string
  viewportResults: VerifyViewportResult[]
  /** Full stdout+stderr from each phase — for debugging, not shown to end users. */
  setupLog: string
  beforeRenderLog: string
  afterRenderLog: string
}

const HARNESS_DIR = "harness"

function unverifiable(errorMessage: string, setupLog = "", beforeRenderLog = "", afterRenderLog = ""): VerifyResult {
  return {
    verdict: "UNVERIFIABLE",
    renderable: false,
    errorMessage,
    viewportResults: [],
    setupLog,
    beforeRenderLog,
    afterRenderLog,
  }
}

/**
 * Verifies one candidate by forking `warmImage` twice — no sandbox setup here,
 * the caller is responsible for `warmImage` already having every dependency
 * `buildCommand` needs installed (see apps/web/lib/pipeline.ts's per-run warm
 * image, or `runVerification` below for the single-candidate case).
 */
export async function verifyFromWarmImage(
  sandbox: SandboxClient,
  warmImage: string,
  input: VerifyFromWarmImageInput,
  setupLog = ""
): Promise<VerifyResult> {
  const renderTimeoutSeconds = input.renderTimeoutSeconds ?? 180
  const viewports = input.viewports ?? VIEWPORTS
  const thresholds = input.thresholds ?? loadThresholdsFromEnv()

  const harnessFiles = prefixFiles(generateHarness(input.harness), HARNESS_DIR)

  const before = await renderVariant(sandbox, warmImage, input, viewports, renderTimeoutSeconds, input.beforeFileContent, harnessFiles)
  if (!before.shoot.renderable) {
    // The ORIGINAL content didn't render — that's a harness/environment
    // problem, not a signal about the patch. §5.7: "do not guess."
    return unverifiable(
      `original content failed to render: ${before.shoot.errorMessage ?? "unknown error"}`,
      setupLog,
      before.log
    )
  }

  const after = await renderVariant(sandbox, warmImage, input, viewports, renderTimeoutSeconds, input.afterFileContent, harnessFiles)
  if (!after.shoot.renderable) {
    // The original rendered fine but the patch doesn't — that IS a real signal
    // about the patch, distinct from the case above.
    return {
      verdict: "FAIL",
      renderable: false,
      errorMessage: `patched content failed to render: ${after.shoot.errorMessage ?? "unknown error"}`,
      viewportResults: [],
      setupLog,
      beforeRenderLog: before.log,
      afterRenderLog: after.log,
    }
  }

  const viewportResults: VerifyViewportResult[] = []
  for (const viewport of viewports) {
    const beforePng = before.shoot.screenshots.get(viewport)
    const afterPng = after.shoot.screenshots.get(viewport)
    if (!beforePng || !afterPng) continue
    const diff = diffPngBuffers(beforePng, afterPng)
    viewportResults.push({ viewport, deltaRatio: diff.deltaRatio, beforePng, afterPng, diffPng: diff.diffPng })
  }

  const verdict = computeVerdict(
    {
      renderable: true,
      viewportResults: viewportResults.map((v) => ({ viewport: v.viewport, deltaRatio: v.deltaRatio })),
      typecheckPassed: input.typecheckPassed,
      lintPassed: input.lintPassed,
    },
    thresholds
  )

  return {
    verdict,
    renderable: true,
    viewportResults,
    setupLog,
    beforeRenderLog: before.log,
    afterRenderLog: after.log,
  }
}

/** Single-candidate entry point: builds its own warm image, then delegates to `verifyFromWarmImage`. */
export async function runVerification(sandbox: SandboxClient, input: VerifyInput): Promise<VerifyResult> {
  const setupTimeoutSeconds = input.setupTimeoutSeconds ?? 600

  // §3.3: build the warm base ONCE. Everything after this forks from the same
  // checkpoint instead of paying install cost per variant.
  const setup = await sandbox.runCommand({
    image: input.baseImage,
    command: `${buildWriteFilesCommand(input.projectFiles)} && ${input.setupCommand}`,
    timeoutSeconds: setupTimeoutSeconds,
  })

  if (setup.exitCode !== 0 || !setup.resultImageUuid) {
    return unverifiable(
      `sandbox setup failed (exit ${setup.exitCode}): ${setup.stderr.slice(-2000) || setup.stdout.slice(-2000)}`,
      setup.stdout
    )
  }

  return verifyFromWarmImage(sandbox, setup.resultImageUuid, input, setup.stdout)
}

/** Forks from `warmImage`, writes the target file + harness + shoot script, builds, and shoots. */
async function renderVariant(
  sandbox: SandboxClient,
  warmImage: string,
  input: Pick<VerifyFromWarmImageInput, "targetFilePath" | "buildCommand" | "buildOutputHtmlPath" | "darkMode">,
  viewports: readonly number[],
  timeoutSeconds: number,
  targetContent: string,
  harnessFiles: FileSet
): Promise<{ shoot: ShootResult; log: string }> {
  const shootScript = generateShootScript({
    htmlPath: input.buildOutputHtmlPath,
    viewports,
    darkMode: input.darkMode,
  })

  // Writing the target file + harness fresh on every render (rather than
  // relying on a prior step having left them in place) is what lets this same
  // function serve both a single-use warm image (runVerification, where it's
  // a harmless redundant write — setup already wrote the same content) and a
  // warm image shared across many candidates in a run (verifyFromWarmImage,
  // where it's the ONLY place these files get written).
  const writeTarget = buildWriteFilesCommand({ [input.targetFilePath]: targetContent, ...harnessFiles })
  const writeShoot = buildWriteFilesCommand({ [`${HARNESS_DIR}/shoot.mjs`]: shootScript })

  const steps = [writeTarget, writeShoot, input.buildCommand, `node ${HARNESS_DIR}/shoot.mjs`]

  const result = await sandbox.runCommand({
    image: warmImage,
    command: steps.join(" && "),
    timeoutSeconds,
  })

  const log = `--- meta --- exitCode=${result.exitCode} timedOut=${result.timedOut} status=${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`

  const shootResult = parseShootOutput(result.stdout)
  if (!shootResult.renderable && !shootResult.errorMessage && result.exitCode !== 0) {
    // The shoot script never got far enough to print its own error marker —
    // most likely the BUILD step failed, not the render itself.
    return {
      shoot: {
        renderable: false,
        errorMessage: `build/render command failed (exit ${result.exitCode}): ${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`,
        screenshots: new Map(),
      },
      log,
    }
  }
  return { shoot: shootResult, log }
}

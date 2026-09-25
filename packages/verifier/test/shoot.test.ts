import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { generateShootScript, parseShootOutput, VIEWPORTS } from "../src/shoot.js"

function findSyntaxErrors(source: string): string[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"] },
  })
  const file = project.createSourceFile("shoot-check.mjs.ts", source)
  return file
    .getPreEmitDiagnostics()
    .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error)
    // Module-resolution noise only — this throwaway project has no node_modules
    // (2792: "cannot find module 'playwright'"), no @types/node (2580: "cannot
    // find name 'process'", the Node-globals-specific variant of 2304), and
    // Node's http.Server type isn't resolvable either without those types,
    // producing 2339 ("property does not exist on type 'unknown'") on server
    // methods further down. This check is for syntax, the same reasoning as
    // harness.test.ts — none of this affects the plain JS that actually runs.
    .filter((d) => ![2792, 2580, 2339].includes(d.getCode()))
    .map((d) => `[${d.getCode()}] ${d.getLineNumber()}: ${d.getMessageText()}`)
}

describe("generateShootScript", () => {
  it("produces syntactically valid JS", () => {
    const script = generateShootScript({ htmlPath: "dist/index.html" })
    expect(findSyntaxErrors(script)).toEqual([])
  })

  it("resolves the html path against cwd at runtime, not baked in at generation time", () => {
    const script = generateShootScript({ htmlPath: "dist/index.html" })
    expect(script).toContain('path.resolve(process.cwd(), "dist/index.html")')
    expect(script).toContain(JSON.stringify(VIEWPORTS))
  })

  it("serves the built output over local HTTP rather than file://", () => {
    // Chromium blocks <script type="module"> loaded from a file:// origin, so
    // a Vite build's output can't just be opened directly — see shoot.ts's header.
    const script = generateShootScript({ htmlPath: "dist/index.html" })
    expect(script).toContain("http.createServer")
    expect(script).toContain("http://127.0.0.1:")
    expect(script).not.toContain("pathToFileURL")
  })

  it("passes waitForFunction's options as the THIRD argument, not the second", () => {
    // page.waitForFunction(pageFunction, arg, options) — passing options as
    // the second positional arg silently falls back to Playwright's own
    // default timeout instead of the one this module was asked for.
    const script = generateShootScript({ htmlPath: "dist/index.html", readyTimeoutMs: 5000 })
    expect(script).toMatch(/waitForFunction\(\s*\(\)\s*=>[\s\S]*?,\s*undefined,\s*\{\s*timeout: READY_TIMEOUT_MS\s*\}/)
    expect(script).toContain("READY_TIMEOUT_MS = 5000")
  })

  it("honors custom viewports", () => {
    const script = generateShootScript({ htmlPath: "dist/index.html", viewports: [320, 1920] })
    expect(script).toContain(JSON.stringify([320, 1920]))
  })

  it("sets colorScheme dark when darkMode is requested", () => {
    const script = generateShootScript({ htmlPath: "dist/index.html", darkMode: true })
    expect(script).toContain('colorScheme: "dark"')
  })

  it("defaults to light color scheme", () => {
    const script = generateShootScript({ htmlPath: "dist/index.html" })
    expect(script).toContain('colorScheme: "light"')
  })

  it("references the same dataset attribute names harness.ts sets", () => {
    const script = generateShootScript({ htmlPath: "dist/index.html" })
    expect(script).toContain("dataset.doppelReady")
    expect(script).toContain("dataset.doppelError")
  })
})

describe("parseShootOutput", () => {
  it("parses multiple screenshots keyed by viewport width", () => {
    const stdout = [
      `DOPPEL_SCREENSHOT:375:${Buffer.from("fake-png-375").toString("base64")}`,
      `DOPPEL_SCREENSHOT:768:${Buffer.from("fake-png-768").toString("base64")}`,
      "DOPPEL_SHOOT_DONE",
    ].join("\n")

    const result = parseShootOutput(stdout)
    expect(result.renderable).toBe(true)
    expect(result.errorMessage).toBeUndefined()
    expect(result.screenshots.size).toBe(2)
    expect(result.screenshots.get(375)?.toString()).toBe("fake-png-375")
    expect(result.screenshots.get(768)?.toString()).toBe("fake-png-768")
  })

  it("marks unrenderable and captures the message on a render error", () => {
    const stdout = `DOPPEL_RENDER_ERROR:${JSON.stringify("ReportViewer must be rendered inside a WorkspaceProvider")}\nDOPPEL_SHOOT_DONE`
    const result = parseShootOutput(stdout)
    expect(result.renderable).toBe(false)
    expect(result.errorMessage).toBe("ReportViewer must be rendered inside a WorkspaceProvider")
    expect(result.screenshots.size).toBe(0)
  })

  it("marks unrenderable when there's no output at all (e.g. the sandbox command itself crashed)", () => {
    const result = parseShootOutput("")
    expect(result.renderable).toBe(false)
    expect(result.errorMessage).toBeUndefined()
    expect(result.screenshots.size).toBe(0)
  })

  it("ignores stray stdout noise around the markers (e.g. debconf/apt warnings)", () => {
    const stdout = [
      "debconf: delaying package configuration, since apt-utils is not installed",
      `DOPPEL_SCREENSHOT:1440:${Buffer.from("fake-png-1440").toString("base64")}`,
      "DOPPEL_SHOOT_DONE",
    ].join("\n")
    const result = parseShootOutput(stdout)
    expect(result.renderable).toBe(true)
    expect(result.screenshots.get(1440)?.toString()).toBe("fake-png-1440")
  })
})

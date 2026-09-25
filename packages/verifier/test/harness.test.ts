import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { generateHarness, HARNESS_ERROR_ATTR, HARNESS_READY_ATTR, type ProviderWrapper } from "../src/harness.js"

/**
 * Same allowlist-based structural check used in scripts/m2-pipeline.ts to catch
 * truncated/malformed JSX — reused here to prove the harness generator produces
 * real, parseable TSX, not just plausible-looking strings.
 */
const STRUCTURAL_ERROR_CODES = new Set([
  1003, 1005, 1109, 1128, 1136, 1145, 1160, 1161, 1381, 1382, 17002, 17008, 2657,
])

function findStructuralErrors(tsxSource: string): string[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  })
  const file = project.createSourceFile("harness-check.tsx", tsxSource)
  return file
    .getPreEmitDiagnostics()
    .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error)
    .filter((d) => STRUCTURAL_ERROR_CODES.has(d.getCode()))
    .map((d) => `L${d.getLineNumber() ?? "?"}: ${d.getMessageText()}`)
}

const themeProvider: ProviderWrapper = {
  imports: ['import { ThemeProvider } from "next-themes"'],
  open: '<ThemeProvider attribute="class">',
  close: "</ThemeProvider>",
}

describe("generateHarness", () => {
  it("produces the expected file set", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/button",
      exportName: "Button",
      props: { children: "Click me" },
    })
    expect(Object.keys(files).sort()).toEqual(["index.html", "src/main.tsx", "vite.config.ts"])
  })

  it("generates structurally valid TSX for a default export with no providers", () => {
    const files = generateHarness({
      componentImportPath: "@/components/marketing/hero",
      exportName: null,
      props: {},
    })
    expect(findStructuralErrors(files["src/main.tsx"])).toEqual([])
    expect(files["src/main.tsx"]).toContain('import TargetComponent from "@/components/marketing/hero"')
  })

  it("generates structurally valid TSX for a named export with synthesized props", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/alert",
      exportName: "Alert",
      props: { variant: "destructive", children: "Something went wrong" },
    })
    expect(findStructuralErrors(files["src/main.tsx"])).toEqual([])
    expect(files["src/main.tsx"]).toContain(
      'import { Alert as TargetComponent } from "@/components/ui/alert"'
    )
    expect(files["src/main.tsx"]).toContain('"variant": "destructive"')
  })

  it("generates structurally valid TSX with multiple nested providers, correctly ordered", () => {
    const memoryRouter: ProviderWrapper = {
      imports: ['import { MemoryRouter } from "react-router-dom"'],
      open: "<MemoryRouter>",
      close: "</MemoryRouter>",
    }
    const files = generateHarness({
      componentImportPath: "@/components/dashboard/widget",
      exportName: "Widget",
      props: {},
      providers: [themeProvider, memoryRouter],
    })
    const main = files["src/main.tsx"]
    expect(findStructuralErrors(main)).toEqual([])

    // Providers must close in reverse order of opening — a real nesting requirement,
    // not just "both tags present somewhere."
    const openThemeIdx = main.indexOf("<ThemeProvider")
    const openRouterIdx = main.indexOf("<MemoryRouter>")
    const closeRouterIdx = main.indexOf("</MemoryRouter>")
    const closeThemeIdx = main.indexOf("</ThemeProvider>")
    expect(openThemeIdx).toBeLessThan(openRouterIdx)
    expect(openRouterIdx).toBeLessThan(closeRouterIdx)
    expect(closeRouterIdx).toBeLessThan(closeThemeIdx)
  })

  it("includes provider imports in the generated file", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/card",
      exportName: "Card",
      props: {},
      providers: [themeProvider],
    })
    expect(files["src/main.tsx"]).toContain('import { ThemeProvider } from "next-themes"')
  })

  it("sets the dark class on <html> when darkMode is requested", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/card",
      exportName: "Card",
      props: {},
      darkMode: true,
    })
    expect(files["index.html"]).toContain('<html class="dark">')
  })

  it("omits the dark class by default", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/card",
      exportName: "Card",
      props: {},
    })
    expect(files["index.html"]).not.toContain("dark")
  })

  it("signals readiness and errors via the exported dataset attribute constants, not magic strings", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/card",
      exportName: "Card",
      props: {},
    })
    expect(files["src/main.tsx"]).toContain(`dataset.${HARNESS_READY_ATTR}`)
    expect(files["src/main.tsx"]).toContain(`dataset.${HARNESS_ERROR_ATTR}`)
  })

  it("wraps the mount in try/catch so a mount failure is observable, not an unhandled crash", () => {
    const files = generateHarness({
      componentImportPath: "@/components/reports/report-viewer",
      exportName: "ReportViewer",
      props: {},
    })
    expect(files["src/main.tsx"]).toMatch(/try\s*{[\s\S]*catch\s*\(/)
  })

  it("extends vite.config.ts's resolve.alias with the target repo's own path aliases", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/button",
      exportName: "Button",
      props: {},
      viteAliases: { "@": "." },
    })
    expect(files["vite.config.ts"]).toContain('"@": path.resolve(__dirname, ".")')
  })

  it("omits resolve.alias entirely when no aliases are given", () => {
    const files = generateHarness({ componentImportPath: "./local-component", exportName: null, props: {} })
    expect(files["vite.config.ts"]).not.toContain("resolve")
  })

  it("imports a global stylesheet before the component when globalCssImportPath is given", () => {
    const files = generateHarness({
      componentImportPath: "@/components/ui/button",
      exportName: "Button",
      props: {},
      globalCssImportPath: "./globals.css",
    })
    const main = files["src/main.tsx"]
    expect(findStructuralErrors(main)).toEqual([])
    expect(main.indexOf('import "./globals.css"')).toBeLessThan(main.indexOf("TargetComponent"))
  })
})

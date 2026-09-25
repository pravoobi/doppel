/**
 * Isolation render harness generation (CLAUDE.md §5.7 step 1). Generates a tiny
 * Vite entry that imports and renders ONE version of the target component with
 * synthesized props, wrapped in caller-supplied providers.
 *
 * Deliberately renders only one variant per harness, not both side by side: per
 * §3.3's sandbox strategy, each patch forks from a warm base image, and the
 * orchestrator runs this SAME harness twice — once against the sandbox state
 * before the patch, once after — rather than the harness itself juggling two
 * component versions. That's what "renders it twice — once from the original
 * source, once patched" (§5.7) means in practice: two runs of one harness, not
 * one harness with two variants.
 *
 * Providers (ThemeProvider, a memory router, a mock query client — §5.7) are
 * caller-supplied snippets, not hardcoded to a specific library: this package
 * doesn't know which router/theme/query library a given target repo uses, and
 * guessing would be worse than asking the orchestrator to supply what it knows.
 *
 * Pure string generation — no execution, no sandbox, no network. Testable by
 * checking the generated TSX parses (see test/harness.test.ts).
 */

export type ProviderWrapper = {
  /** Import statement(s) this wrapper needs, e.g. ['import { ThemeProvider } from "next-themes"']. */
  imports: string[]
  /** Opening JSX tag, e.g. '<ThemeProvider attribute="class">'. */
  open: string
  /** Matching closing JSX tag, e.g. '</ThemeProvider>'. */
  close: string
}

export type HarnessInput = {
  /** Import path exactly as the target repo would resolve it, e.g. "@/components/marketing/hero". */
  componentImportPath: string
  /** Named export to render, or null to use the default export. */
  exportName: string | null
  /** Synthesized props (§5.7's prop-synthesis step) — must be JSON-serializable. */
  props: Record<string, unknown>
  providers?: ProviderWrapper[]
  /** Adds a `dark` class to <html> — §5.7 step 2: "plus dark mode if the repo sets a dark class." */
  darkMode?: boolean
  /**
   * Target repo's own path aliases (from its tsconfig `paths`), e.g.
   * `{ "@": "." }` — repo-specific, so the orchestrator supplies it rather than
   * this module guessing. Resolved relative to the generated vite.config.ts's
   * own directory, matching Vite's convention.
   */
  viteAliases?: Record<string, string>
  /** A global stylesheet to import before rendering (e.g. compiled Tailwind output). */
  globalCssImportPath?: string
}

export type HarnessFiles = Record<string, string>

/**
 * Markers the generated entry sets on `document.body.dataset` so an external
 * driver (Playwright, eventually) can poll for readiness or failure without
 * guessing at timing. Exported so the shoot/sandbox stages use the exact same
 * strings rather than duplicating them.
 */
export const HARNESS_READY_ATTR = "doppelReady"
export const HARNESS_ERROR_ATTR = "doppelError"

function serializeProps(props: Record<string, unknown>): string {
  // JSON round-trip is intentional: synthesized props are plain data (§5.7 —
  // Ultra generates a fixture from the TS signature), never functions/JSX, so
  // this never needs to handle non-serializable values.
  return JSON.stringify(props, null, 2)
}

export function generateHarness(input: HarnessInput): HarnessFiles {
  const providers = input.providers ?? []
  const importName = input.exportName
    ? `{ ${input.exportName} as TargetComponent }`
    : "TargetComponent"

  const providerImports = providers.flatMap((p) => p.imports)
  const openTags = providers.map((p) => p.open).join("\n    ")
  const closeTags = [...providers.map((p) => p.close)].reverse().join("\n    ")

  const globalCssImport = input.globalCssImportPath ? `import "${input.globalCssImportPath}"\n` : ""

  const mainTsx = `import React from "react"
import ReactDOM from "react-dom/client"
${globalCssImport}import ${importName} from "${input.componentImportPath}"
${providerImports.join("\n")}

const props = ${serializeProps(input.props)}

const root = document.getElementById("root")
if (!root) {
  throw new Error("harness: #root element missing from index.html")
}

try {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
    ${openTags}
    <TargetComponent {...props} />
    ${closeTags}
    </React.StrictMode>
  )
  // A microtask delay lets React commit before we signal readiness — Playwright
  // polls this attribute instead of a fixed sleep.
  queueMicrotask(() => {
    document.body.dataset.${HARNESS_READY_ATTR} = "true"
  })
} catch (err) {
  // "If it still won't mount → verdict UNVERIFIABLE, stop here, do not guess."
  // (§5.7 step 1). This is the signal that decision is based on.
  document.body.dataset.${HARNESS_ERROR_ATTR} = err instanceof Error ? err.message : String(err)
}
`

  const indexHtml = `<!doctype html>
<html${input.darkMode ? ' class="dark"' : ""}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>doppel harness</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

  const aliasEntries = Object.entries(input.viteAliases ?? {})
  const aliasImports = aliasEntries.length > 0 ? `import path from "node:path"\n` : ""
  const aliasConfig =
    aliasEntries.length > 0
      ? `\n  resolve: {\n    alias: {\n${aliasEntries
          .map(([find, replacement]) => `      "${find}": path.resolve(__dirname, ${JSON.stringify(replacement)}),`)
          .join("\n")}\n    },\n  },`
      : ""

  const viteConfig = `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
${aliasImports}
export default defineConfig({
  plugins: [react()],${aliasConfig}
})
`

  return {
    "index.html": indexHtml,
    "src/main.tsx": mainTsx,
    "vite.config.ts": viteConfig,
  }
}

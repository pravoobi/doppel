/**
 * M3 gate validation (CLAUDE.md §10): one real end-to-end verification run —
 * harness → sandbox → shoot → diff → verdict — against a real M2 migration,
 * proving the loop yields a real verdict with real image artifacts. This is a
 * live run: it spawns real sandboxes, installs real dependencies (npm, then
 * Playwright + Chromium), and will take several minutes for the setup phase
 * alone. Costs real credits.
 *
 * Target: btn-001 ("Export CSV" — app/page.tsx in fixtures/drift-demo), the
 * simplest, most reliably-migrating case from the M2 pipeline runs. Before:
 * the original hand-rolled <button>. After: the real Ultra-generated
 * <Button onClick={...}>Export CSV</Button> migration, single-quoted per the
 * fix that got M2's gate to 15/15 (see docs/DECISIONS.md).
 *
 * Run: pnpm m3-pipeline
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SandboxClient, runVerification, type FileSet } from "@doppel/verifier"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/drift-demo")

function read(relPath: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, relPath), "utf8")
}

async function main() {
  const apiKey = process.env.NEBIUS_API_KEY
  const projectId = process.env.NEBIUS_PROJECT_ID
  if (!apiKey || !projectId) {
    console.error("NEBIUS_API_KEY and NEBIUS_PROJECT_ID must be set. See .env.example.")
    process.exit(1)
  }

  const sandbox = new SandboxClient({ apiKey, projectId })

  const HARNESS_ROOT = "harness"

  const projectFiles: FileSet = {
    [`${HARNESS_ROOT}/package.json`]: JSON.stringify(
      {
        name: "doppel-harness",
        private: true,
        type: "module",
        dependencies: {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
          clsx: "^2.1.1",
          "tailwind-merge": "^2.5.0",
          "class-variance-authority": "^0.7.0",
        },
        devDependencies: {
          vite: "^5.4.0",
          "@vitejs/plugin-react": "^4.3.0",
          tailwindcss: "^3.4.13",
          postcss: "^8.4.47",
          autoprefixer: "^10.4.20",
          playwright: "^1.47.0",
        },
      },
      null,
      2
    ),
    [`${HARNESS_ROOT}/lib/utils.ts`]: read("lib/utils.ts"),
    [`${HARNESS_ROOT}/components/ui/button.tsx`]: read("components/ui/button.tsx"),
    [`${HARNESS_ROOT}/tailwind.config.ts`]: read("tailwind.config.ts").replace(
      'content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"]',
      // Matches only what actually exists under the harness root — a bare
      // "./**/*.{ts,tsx}" also matches node_modules and both slows the build
      // and triggers Tailwind's own warning about it.
      'content: ["./*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"]'
    ),
    [`${HARNESS_ROOT}/postcss.config.js`]: read("postcss.config.js"),
    [`${HARNESS_ROOT}/globals.css`]: read("app/globals.css"),
  }

  const targetFilePath = `${HARNESS_ROOT}/harness-target.tsx`

  const beforeFileContent = `export default function HarnessTarget() {
  return (
    <button
      onClick={() => window.print()}
      className="inline-flex h-9 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
    >
      Export CSV
    </button>
  )
}
`

  // The real Ultra output from the M2 pipeline run that hit 15/15 (single
  // quotes per that fix — see docs/DECISIONS.md, "Root cause found and fixed").
  const afterFileContent = `import { Button } from "@/components/ui/button"

export default function HarnessTarget() {
  return <Button onClick={() => window.print()}>Export CSV</Button>
}
`

  console.log("Starting M3 verification run (this will take several minutes)...\n")

  const result = await runVerification(sandbox, {
    projectFiles,
    targetFilePath,
    beforeFileContent,
    afterFileContent,
    harness: {
      componentImportPath: "@/harness-target",
      exportName: null,
      props: {},
      viteAliases: { "@": "." },
      globalCssImportPath: "../globals.css",
    },
    typecheckPassed: true, // already proven by scripts/m2-pipeline.ts for this exact migration
    lintPassed: true, // no ESLint config in the fixture yet (M1/M2 scope) — not a real signal either way
    // node:22-slim isn't in this account's pre-registered image catalog (GET
    // /images) — node:20-slim is, confirmed via a live check before this run.
    baseImage: "tag:node:20-slim",
    setupCommand: `cd ${HARNESS_ROOT} && npm install && npx playwright install --with-deps chromium`,
    buildCommand: `(cd ${HARNESS_ROOT} && npx vite build)`,
    buildOutputHtmlPath: `${HARNESS_ROOT}/dist/index.html`,
    setupTimeoutSeconds: 600,
    renderTimeoutSeconds: 180,
    // Root cause of the earlier "cuts off after viewport 1" mystery found and
    // fixed in sandbox.ts: large stdout comes back with encoding: "base64"
    // (the whole value re-encoded, not just individual fields), which was
    // being treated as literal text. Back to all 3 viewports per §5.7 step 2.
  })

  console.log("\n=== Result ===")
  console.log(`verdict: ${result.verdict}`)
  console.log(`renderable: ${result.renderable}`)
  if (result.errorMessage) console.log(`errorMessage: ${result.errorMessage}`)

  const outDir = path.resolve(__dirname, "../.doppel/m3-artifacts")
  fs.mkdirSync(outDir, { recursive: true })

  for (const v of result.viewportResults) {
    console.log(`  viewport ${v.viewport}: deltaRatio=${v.deltaRatio.toFixed(4)}`)
    fs.writeFileSync(path.join(outDir, `${v.viewport}-before.png`), v.beforePng)
    fs.writeFileSync(path.join(outDir, `${v.viewport}-after.png`), v.afterPng)
    fs.writeFileSync(path.join(outDir, `${v.viewport}-diff.png`), v.diffPng)
  }

  fs.writeFileSync(path.join(outDir, "setup.log"), result.setupLog)
  fs.writeFileSync(path.join(outDir, "before-render.log"), result.beforeRenderLog)
  fs.writeFileSync(path.join(outDir, "after-render.log"), result.afterRenderLog)
  fs.writeFileSync(
    path.join(outDir, "result.json"),
    JSON.stringify({ verdict: result.verdict, renderable: result.renderable, errorMessage: result.errorMessage, viewports: result.viewportResults.map((v) => ({ viewport: v.viewport, deltaRatio: v.deltaRatio })) }, null, 2)
  )

  console.log(`\n${result.viewportResults.length > 0 ? "GATE PASSED — real verdict with real image artifacts" : "GATE NOT MET"}`)
  console.log(`Artifacts: ${path.relative(process.cwd(), outDir)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

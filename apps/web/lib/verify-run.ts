/**
 * Wires M3 (packages/verifier) into a live run: builds ONE warm sandbox image
 * per run (dependencies installed once) and verifies every DRIFT candidate by
 * forking that SAME image, per CLAUDE.md §3.3's "fork per patch from a warm
 * base" — not one `npm install` per candidate, which §3.3 explicitly calls
 * "far too slow — you'd burn the whole verification budget on npm."
 *
 * Scope cut, same honesty pattern as pipeline.ts's own header comment: this
 * only knows how to build a harness for the CURRENT repo shape (a Vite-buildable
 * React + Tailwind app with a `components/ui` design system, matching
 * fixtures/drift-demo and scripts/m3-pipeline.ts's proven setup) — a real
 * per-repo build-system detector is its own design pass, not done here.
 *
 * Isolation strategy: rather than rendering the candidate's CONTAINING file
 * (which may need router/auth/data context this orchestrator has no way to
 * synthesize), each candidate's own extracted JSX (before) and migrated JSX
 * (after) is wrapped standalone as `export default function HarnessTarget()`.
 * This sidesteps needing props-synthesis for whole pages, at a real cost: a
 * candidate whose JSX references its enclosing scope (a local handler, a
 * mapped item, component state) won't compile standalone and correctly comes
 * back UNVERIFIABLE — CLAUDE.md §5.7 step 1's "if it still won't mount →
 * UNVERIFIABLE, stop here, do not guess," working exactly as intended rather
 * than a limitation being papered over.
 */

import fs from "node:fs"
import path from "node:path"
import {
  SandboxClient,
  buildWriteFilesCommand,
  verifyFromWarmImage,
  type FileSet,
  type VerifyResult,
} from "@doppel/verifier"

const HARNESS_ROOT = "harness"
// node:22-slim isn't in this account's pre-registered image catalog (GET
// /images) — node:20-slim is, confirmed live (see docs/DECISIONS.md, M3).
const BASE_IMAGE = "tag:node:20-slim"

export type VerifyCandidateInput = {
  /** The candidate's own original JSX source (a single element/expression). */
  beforeJsx: string
  /** The migrated JSX from packages/agent's migrateCandidate. */
  afterJsx: string
  /** Import statements the migrated JSX needs (Migration.importsToAdd). */
  importsToAdd: string[]
  typecheckPassed: boolean
}

/** Exported so pipeline.ts can typecheck the EXACT content that gets rendered, not a re-derived approximation of it. */
export function wrapAsStandaloneComponent(jsx: string, importLines: string[] = []): string {
  const imports = importLines.length > 0 ? importLines.join("\n") + "\n\n" : ""
  return `${imports}export default function HarnessTarget() {\n  return (\n    ${jsx}\n  )\n}\n`
}

function readFilesRecursive(dirAbsPath: string, relPrefix: string, out: FileSet): void {
  for (const entry of fs.readdirSync(dirAbsPath, { withFileTypes: true })) {
    const abs = path.join(dirAbsPath, entry.name)
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      readFilesRecursive(abs, rel, out)
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out[rel] = fs.readFileSync(abs, "utf8")
    }
  }
}

/** Mirrors scripts/m3-pipeline.ts's proven project-files list, generalized to every DS component instead of just Button. */
function buildProjectFiles(repoRoot: string, dsPath: string): FileSet {
  const read = (relPath: string) => fs.readFileSync(path.join(repoRoot, relPath), "utf8")

  const files: FileSet = {
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
    [`${HARNESS_ROOT}/tailwind.config.ts`]: read("tailwind.config.ts").replace(
      'content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"]',
      'content: ["./*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"]'
    ),
    [`${HARNESS_ROOT}/postcss.config.js`]: read("postcss.config.js"),
    [`${HARNESS_ROOT}/globals.css`]: read("app/globals.css"),
  }

  readFilesRecursive(path.join(repoRoot, dsPath), `${HARNESS_ROOT}/${dsPath}`, files)
  return files
}

/**
 * Builds one warm sandbox image per run (memoized — the first call pays the
 * npm-install/Playwright-install cost, every later call in the same run
 * reuses it) and verifies candidates against it.
 */
export class RunVerifier {
  private warmImage: Promise<{ image: string; setupLog: string } | { error: string }> | null = null

  constructor(
    private readonly sandbox: SandboxClient,
    private readonly repoRoot: string,
    private readonly dsPath: string
  ) {}

  private ensureWarmImage() {
    if (!this.warmImage) {
      this.warmImage = this.buildWarmImage()
    }
    return this.warmImage
  }

  private async buildWarmImage(): Promise<{ image: string; setupLog: string } | { error: string }> {
    const projectFiles = buildProjectFiles(this.repoRoot, this.dsPath)
    const setup = await this.sandbox.runCommand({
      image: BASE_IMAGE,
      command: `${buildWriteFilesCommand(projectFiles)} && cd ${HARNESS_ROOT} && npm install && npx playwright install --with-deps chromium`,
      timeoutSeconds: 600,
    })
    if (setup.exitCode !== 0 || !setup.resultImageUuid) {
      return { error: `sandbox setup failed (exit ${setup.exitCode}): ${(setup.stderr || setup.stdout).slice(-2000)}` }
    }
    return { image: setup.resultImageUuid, setupLog: setup.stdout }
  }

  async verifyCandidate(input: VerifyCandidateInput): Promise<VerifyResult> {
    const warm = await this.ensureWarmImage()
    if ("error" in warm) {
      return {
        verdict: "UNVERIFIABLE",
        renderable: false,
        errorMessage: warm.error,
        viewportResults: [],
        setupLog: "",
        beforeRenderLog: "",
        afterRenderLog: "",
      }
    }

    return verifyFromWarmImage(
      this.sandbox,
      warm.image,
      {
        targetFilePath: `${HARNESS_ROOT}/harness-target.tsx`,
        beforeFileContent: wrapAsStandaloneComponent(input.beforeJsx),
        afterFileContent: wrapAsStandaloneComponent(input.afterJsx, input.importsToAdd),
        harness: {
          componentImportPath: "@/harness-target",
          exportName: null,
          props: {},
          viteAliases: { "@": "." },
          globalCssImportPath: "../globals.css",
        },
        typecheckPassed: input.typecheckPassed,
        // No ESLint config in the fixture yet (M1/M2 scope) — not a real
        // signal either way, same documented cut as scripts/m3-pipeline.ts.
        lintPassed: true,
        // Parens make this a SUBSHELL — required, not cosmetic, twice over:
        // (1) without `cd` at all, `npx vite build` runs from the sandbox's
        // root cwd, finds no local `vite` in node_modules/.bin, and npx
        // silently fetches+runs the LATEST vite from the registry instead of
        // the pinned devDependency (confirmed live: v8.3.0 instead of ^5.4.0,
        // a build failure that looks like a real error but is actually just
        // the wrong tool version); (2) a BARE `cd harness && npx vite build`
        // leaks its cd into the *next* step in this same joined command
        // (`node harness/shoot.mjs`, appended by verify.ts's renderVariant),
        // resolving it against the now-changed cwd as the broken
        // `harness/harness/shoot.mjs` — confirmed live too. Matches
        // scripts/m3-pipeline.ts's own buildCommand exactly; dropping the
        // parens was the bug, not the cd itself.
        buildCommand: `(cd ${HARNESS_ROOT} && npx vite build)`,
        buildOutputHtmlPath: `${HARNESS_ROOT}/dist/index.html`,
        renderTimeoutSeconds: 180,
      },
      warm.setupLog
    )
  }
}

export function createSandboxClientFromEnv(): SandboxClient | null {
  const apiKey = process.env.NEBIUS_API_KEY
  const projectId = process.env.NEBIUS_PROJECT_ID
  if (!apiKey || !projectId) return null
  return new SandboxClient({ apiKey, projectId })
}

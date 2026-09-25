import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";

// Next.js only auto-loads .env files from this app's own directory
// (apps/web), not the monorepo root where the real .env lives — everything
// else in the repo (scripts, other packages) loads it via
// `tsx --env-file=.env` instead. Mirror that here so DATABASE_URL etc. reach
// this process; already-set env vars (e.g. injected by a deploy platform)
// take precedence over the file, matching Node's own --env-file semantics.
const rootEnvPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const nextConfig: NextConfig = {
  // Workspace packages ship raw TS source (no build step) with explicit .js
  // extensions on relative imports — standard for `moduleResolution: bundler`
  // + tsx-run scripts, but Turbopack doesn't do that .js->.ts resolution
  // itself unless the package is listed here (a known monorepo pattern, not
  // specific to this project).
  transpilePackages: [
    "@doppel/shared",
    "@doppel/scanner",
    "@doppel/agent",
    "@doppel/verifier",
    "@doppel/db",
    "@doppel/github",
  ],
  // Same class of bug, two instances: anything read via a runtime `fs` call
  // (not a static import) is invisible to Next's file-tracing, which decides
  // what ships in a deployed serverless function. Worked in local dev (whole
  // repo on disk) and failed only once actually deployed — see
  // docs/DECISIONS.md, 2026-09-25, for both.
  //   1. @doppel/shared's pricing.ts reads config/pricing.json.
  //   2. lib/pipeline.ts's default "Start demo run" scans
  //      fixtures/drift-demo via ts-morph's own filesystem glob — the whole
  //      fixture needs to ship, not just the app source files that get
  //      `import`ed elsewhere. node_modules is explicitly excluded below:
  //      the fixture's own node_modules would bloat the function well past
  //      what's needed for scanning; verify's typecheck step may be less
  //      precise on third-party import types as a result — an accepted,
  //      bounded tradeoff, not a crash. A `**` glob from the fixture ROOT
  //      was tried first and rejected: it matches `node_modules/**` too
  //      (confirmed live — 5586 of 5639 traced files were from
  //      node_modules), and `outputFileTracingExcludes` did NOT override
  //      it in testing. Enumerating known subdirectories instead of
  //      globbing from the root avoids ever touching node_modules at all,
  //      no exclude rule needed. The same fixture list also covers what
  //      lib/verify-run.ts's harness assembly needs (lib/utils.ts,
  //      tailwind/postcss configs, app/globals.css, components/** —
  //      already enumerated below for the scan step).
  //   3. @doppel/agent's prompts.ts loads packages/agent/prompts/*.md the
  //      same way — CLAUDE.md §15 requires this ("loaded at runtime, never
  //      inlined in code"), so the fix has to be tracing, not changing the
  //      loading strategy. Found via the SAME class of bug as #1/#2, this
  //      time with a real captured error message (see runs.error_message,
  //      added specifically because diagnosing #1/#2 without one was slow):
  //      `ENOENT ... /var/task/packages/agent/prompts/triage.md`.
  outputFileTracingIncludes: {
    "/**": [
      "../../config/pricing.json",
      "../../packages/agent/prompts/*.md",
      "../../fixtures/drift-demo/app/**/*.tsx",
      "../../fixtures/drift-demo/app/**/*.css",
      "../../fixtures/drift-demo/components/**/*.tsx",
      "../../fixtures/drift-demo/lib/**/*.ts",
      "../../fixtures/drift-demo/tsconfig.json",
      "../../fixtures/drift-demo/package.json",
      "../../fixtures/drift-demo/postcss.config.js",
      "../../fixtures/drift-demo/tailwind.config.ts",
    ],
  },
};

export default nextConfig;

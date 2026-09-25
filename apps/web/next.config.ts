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
  // @doppel/shared's pricing.ts reads config/pricing.json via a computed
  // fs.readFileSync path, not a static import — Next's file-tracing (what
  // decides which non-code files ship in a deployed serverless function)
  // only follows import/require statements, so it never finds this file.
  // Worked in local dev (full repo on disk) and broke silently in
  // production (ENOENT inside the function) until traced explicitly here.
  outputFileTracingIncludes: {
    "/**": ["../../config/pricing.json"],
  },
};

export default nextConfig;

/**
 * POST /api/runs — starts a run (CLAUDE.md §4's `app/api/runs/route.ts`).
 *
 * Cloning an arbitrary repo isn't implemented yet (see lib/pipeline.ts's own
 * header) — `repoRoot` must be a local path already on disk. Defaults to the
 * fixture, so "start a demo run" needs no input at all; this is also exactly
 * the dogfooding path CLAUDE.md §8 asks for.
 *
 * Returns as soon as the run row exists (fast — a single insert), then fires
 * the actual pipeline via `after()` rather than a bare un-awaited call. This
 * used to be a documented known limitation — confirmed live on the Vercel
 * deployment (2026-09-25): a bare un-awaited `executeRun(...)` works in a
 * long-lived `next dev`/`next start` process (the process just keeps running),
 * but on Vercel the platform can freeze/tear down the function once the
 * response is sent, cutting the in-flight pipeline off mid-run and surfacing
 * as `status: "failed"` with no real error to show for it. `after()` is
 * Next.js's own API for exactly this — on Vercel it's wired to `waitUntil`,
 * which keeps the function alive for this extra work up to `maxDuration`
 * below. A real background-job queue (CLAUDE.md §3.4's Serverless Jobs, or a
 * Postgres-backed table + poller) is still the correct long-term answer for a
 * pipeline that can run longer than any function's max duration — `after()`
 * raises the ceiling, it doesn't remove it.
 */

import { NextResponse, after } from "next/server"
import path from "node:path"
import { createRun, executeRun, type RunPipelineInput } from "@/lib/pipeline"

// Vercel's serverless function time limit. 300s (5 min) is a value commonly
// supported on paid plans without extra configuration — verify (M3) live
// sandbox renders are the slowest part of a run and a full run can still
// exceed this for a repo with many DRIFT candidates, so this raises the
// ceiling meaningfully without asserting a number this codebase can't
// actually confirm your plan supports. Check your Vercel plan's own maximum
// function duration and raise this to match if a run still gets cut short —
// exceeding your plan's ceiling here fails the deploy build, so don't guess
// upward past what your dashboard says you have.
export const maxDuration = 300

// process.cwd(), not import.meta.url — Next.js bundles server routes into
// .next/server/..., which changes a file's own directory at runtime but not
// the process's working directory (set by how `next dev`/`next start` was
// launched, from apps/web). apps/web -> apps -> doppel root.
const FIXTURE_ROOT = path.resolve(process.cwd(), "../../fixtures/drift-demo")

export async function POST(request: Request) {
  let body: Partial<RunPipelineInput> = {}
  try {
    body = await request.json()
  } catch {
    // No body / not JSON — fall through to the fixture defaults below.
  }

  const input: RunPipelineInput = {
    repoRoot: body.repoRoot ?? FIXTURE_ROOT,
    repoUrl: body.repoUrl ?? "fixtures/drift-demo",
    ref: body.ref,
    dsPath: body.dsPath ?? "components/ui",
  }

  let run
  try {
    run = await createRun(input)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Failed to start run: ${message}` }, { status: 500 })
  }

  // See file header: after() instead of a bare un-awaited call, so the
  // platform (Vercel) keeps this function alive for the pipeline's duration
  // instead of tearing it down once the response below is sent.
  after(() =>
    executeRun(run, input).catch((err) => {
      console.error(`run ${run.id} crashed outside executeRun's own error handling:`, err)
    })
  )

  return NextResponse.json({ runId: run.id }, { status: 202 })
}

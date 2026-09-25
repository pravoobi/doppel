/**
 * POST /api/runs — starts a run (CLAUDE.md §4's `app/api/runs/route.ts`).
 *
 * Cloning an arbitrary repo isn't implemented yet (see lib/pipeline.ts's own
 * header) — `repoRoot` must be a local path already on disk. Defaults to the
 * fixture, so "start a demo run" needs no input at all; this is also exactly
 * the dogfooding path CLAUDE.md §8 asks for.
 *
 * Returns as soon as the run row exists (fast — a single insert), then fires
 * the actual pipeline without awaiting it. A real background-job queue
 * (CLAUDE.md §3.4's Serverless Jobs, or a Postgres-backed table + poller) is
 * the correct long-term answer; this is the pragmatic version for now, and it
 * genuinely works for the same reason a long-lived `next dev`/`next start`
 * Node process keeps executing a detached promise after the response is
 * sent — it would NOT survive a true serverless/edge deployment that freezes
 * the process after responding, which is a real, known limitation of this cut.
 */

import { NextResponse } from "next/server"
import path from "node:path"
import { createRun, executeRun, type RunPipelineInput } from "@/lib/pipeline"

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

  // Deliberately not awaited — see file header.
  executeRun(run, input).catch((err) => {
    console.error(`run ${run.id} crashed outside executeRun's own error handling:`, err)
  })

  return NextResponse.json({ runId: run.id }, { status: 202 })
}

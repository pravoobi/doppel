import Link from "next/link"
import { getDb, runs } from "@doppel/db"
import { desc } from "drizzle-orm"
import { Card, CardContent } from "@/components/ui/card"
import { RunStatusBadge } from "@/components/run-status-badge"
import { StartRunButton } from "@/components/start-run-button"

// Confirmed live (2026-09-26): without this, Vercel's edge CDN cached this
// page for hours (X-Vercel-Cache: HIT, Age: 40274) despite it doing a live
// DB read on every request — Next's default caching heuristics treat a page
// with no explicit dynamic API usage as cacheable, and this one has none
// (no cookies/headers/searchParams). That's silently wrong for a page whose
// entire point is showing current run status; force-dynamic opts out of
// caching at every layer instead of relying on inferred behavior.
export const dynamic = "force-dynamic"

function formatRelativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export default async function HomePage() {
  let runList: Awaited<ReturnType<typeof loadRuns>> = []
  let dbError: string | null = null
  try {
    runList = await loadRuns()
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Doppel</h1>
          <p className="text-sm text-muted-foreground">
            Design-system drift runs — find hand-rolled components, migrate them, verify by
            rendering.
          </p>
        </div>
        {!dbError && <StartRunButton />}
      </header>

      {dbError && (
        <Card className="border-destructive/50">
          <CardContent className="flex flex-col gap-1 pt-6">
            <p className="text-sm font-medium text-destructive">Database not configured</p>
            <p className="text-sm text-muted-foreground">{dbError}</p>
            <p className="text-sm text-muted-foreground">
              Set <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">DATABASE_URL</code> in{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code> to see run
              history and start runs.
            </p>
          </CardContent>
        </Card>
      )}

      {!dbError && runList.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <p className="text-sm font-medium">No runs yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Start a demo run against the fixture (18 planted drift cases) — no repo URL needed,
              this is exactly the dogfooding path in CLAUDE.md §8.
            </p>
          </CardContent>
        </Card>
      )}

      {runList.length > 0 && (
        <ul className="flex flex-col gap-2">
          {runList.map((run) => (
            <li key={run.id}>
              <Link
                href={`/runs/${run.id}`}
                className="flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-accent"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-sm font-medium">{run.repoUrl}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(run.startedAt)}
                    {run.stats ? ` · ${run.stats.drifts} drift${run.stats.drifts === 1 ? "" : "s"} found` : ""}
                  </span>
                </div>
                <RunStatusBadge status={run.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

async function loadRuns() {
  const db = getDb()
  return db.select().from(runs).orderBy(desc(runs.startedAt)).limit(20)
}

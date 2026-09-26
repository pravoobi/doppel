import Link from "next/link"
import { notFound } from "next/navigation"
import { eq } from "drizzle-orm"
import { getDb, runs, findings, type Finding } from "@doppel/db"
import { RunStatusBadge } from "@/components/run-status-badge"
import { FindingCard } from "@/components/finding-card"
import { AutoRefresh } from "@/components/auto-refresh"
import { DriftMap } from "@/components/drift-map"
import { OpenPrButton } from "@/components/open-pr-button"

// See app/page.tsx's identical directive for why — confirmed live, Vercel's
// edge CDN can cache a page for hours despite a live DB read, and this
// page's whole `<AutoRefresh>` mechanism (client-side router.refresh() every
// few seconds) is worthless against a cached response: it would just
// re-fetch the same stale HTML repeatedly instead of ever seeing a run's
// real progress. This page also reads `searchParams`, which nudges Next
// toward dynamic rendering on its own — force-dynamic makes it explicit
// instead of relying on that inference holding at every caching layer.
export const dynamic = "force-dynamic"

// CLAUDE.md §9: "Verdict filters across the top, with counts. Default to PASS;
// make REVIEW one click." A finding's bucket is its verdict when it has one
// (DRIFT candidates that reached verify); otherwise its classification
// (NOT_DRIFT/INTENTIONAL_DEVIATION never reach verify, so never get a
// verdict — see pipeline.ts) or PENDING for a DRIFT finding verify hasn't
// gotten to yet (no NEBIUS_API_KEY/PROJECT_ID configured, or verify errored).
type FilterKey = "all" | "PASS" | "REVIEW" | "FAIL" | "UNVERIFIABLE" | "PENDING" | "INTENTIONAL_DEVIATION" | "NOT_DRIFT"

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "PASS", label: "Pass" },
  { key: "REVIEW", label: "Review" },
  { key: "FAIL", label: "Fail" },
  { key: "UNVERIFIABLE", label: "Unverifiable" },
  { key: "PENDING", label: "Pending" },
  { key: "INTENTIONAL_DEVIATION", label: "Intentional deviation" },
  { key: "NOT_DRIFT", label: "Not drift" },
]

function filterKeyFor(f: Pick<Finding, "verdict" | "classification">): FilterKey {
  if (f.classification === "INTENTIONAL_DEVIATION") return "INTENTIONAL_DEVIATION"
  if (f.classification === "NOT_DRIFT") return "NOT_DRIFT"
  if (f.verdict) return f.verdict as FilterKey
  return "PENDING"
}

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>
  searchParams: Promise<{ filter?: string; file?: string }>
}) {
  const { runId } = await params
  const { filter: rawFilter, file: fileFilter } = await searchParams
  // "Default to PASS" per §9 — but only when the query string doesn't already
  // pick something else, so following an "All"/other link doesn't get
  // silently overridden back to PASS on the next render.
  const filter: FilterKey = FILTERS.some((f) => f.key === rawFilter)
    ? (rawFilter as FilterKey)
    : rawFilter === undefined
      ? "PASS"
      : "all"

  const db = getDb()
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!run) notFound()

  const allFindings = await db.select().from(findings).where(eq(findings.runId, runId))
  const counts = countByFilterKey(allFindings)
  const visible = allFindings
    .filter((f) => filter === "all" || filterKeyFor(f) === filter)
    .filter((f) => !fileFilter || f.file === fileFilter)

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      {run.status === "running" && <AutoRefresh />}

      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          ← All runs
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-medium">{run.repoUrl}</h1>
          <p className="text-sm text-muted-foreground">
            {run.dsPath && `ds: ${run.dsPath} · `}
            started {run.startedAt.toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/runs/${runId}/cost`} className="text-sm text-muted-foreground hover:underline">
            Cost →
          </Link>
          {run.status === "completed" && <OpenPrButton runId={runId} passCount={counts.PASS ?? 0} />}
          <RunStatusBadge status={run.status} />
        </div>
      </header>

      {run.stats && (
        <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-5">
          <Stat label="Files scanned" value={run.stats.filesScanned} />
          <Stat label="Candidates" value={run.stats.candidates} />
          <Stat label="Filtered pre-inference" value={run.stats.filtered} />
          <Stat label="Triaged" value={run.stats.triaged} />
          <Stat label="Drifts" value={run.stats.drifts} />
        </dl>
      )}

      {run.status === "running" && allFindings.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Scanning and triaging — findings will appear as they&apos;re classified.
        </p>
      )}

      {run.status === "failed" && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          <p>This run failed. Findings collected before the failure are still shown below.</p>
          {run.errorMessage ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs">{run.errorMessage}</pre>
          ) : (
            <p className="mt-1 text-xs text-destructive/70">
              No error message recorded (this run predates that being captured) — check server logs.
            </p>
          )}
        </div>
      )}

      {allFindings.length === 0 && run.status === "completed" && (
        <p className="text-sm text-muted-foreground">
          No drift candidates survived triage. Either the design system is fully adopted here, or
          triage was too conservative — worth a look either way.
        </p>
      )}

      {allFindings.length > 0 && (
        <>
          {run.stats?.fileLoc && (
            <DriftMap runId={runId} fileLoc={run.stats.fileLoc} findings={allFindings} />
          )}

          <nav className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/runs/${runId}?filter=${f.key}${fileFilter ? `&file=${encodeURIComponent(fileFilter)}` : ""}`}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f.key ? "bg-foreground text-background" : "hover:bg-accent"
                }`}
              >
                {f.label} ({f.key === "all" ? allFindings.length : (counts[f.key] ?? 0)})
              </Link>
            ))}
            {fileFilter && (
              <Link
                href={`/runs/${runId}?filter=${filter}`}
                className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
              >
                file: {fileFilter.split("/").pop()} ✕
              </Link>
            )}
          </nav>

          <div className="flex flex-col gap-4">
            {visible.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
            {visible.length === 0 && (
              <p className="text-sm text-muted-foreground">No findings match this filter.</p>
            )}
          </div>
        </>
      )}
    </main>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function countByFilterKey(items: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = filterKeyFor(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

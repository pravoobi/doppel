import Link from "next/link"
import { notFound } from "next/navigation"
import { eq } from "drizzle-orm"
import { getDb, runs, llmCalls, type LlmCall } from "@doppel/db"
import { estimateCostUsd, arePricesConfirmed } from "@doppel/shared"
import { NEMOTRON_MODELS } from "@doppel/agent"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

// See app/page.tsx's identical directive for why — a page doing a live DB
// read needs this stated explicitly, not inferred, or Vercel's edge CDN can
// cache it for hours.
export const dynamic = "force-dynamic"

const TIER_ORDER = ["nano", "super", "ultra"] as const

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00"
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function fmtTokens(n: number): string {
  return n.toLocaleString()
}

type Group = { calls: number; promptTokens: number; completionTokens: number; costUsd: number; costKnown: boolean }

function emptyGroup(): Group {
  return { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, costKnown: true }
}

function addCall(g: Group, call: LlmCall) {
  g.calls += 1
  g.promptTokens += call.promptTokens
  g.completionTokens += call.completionTokens
  if (call.costUsd == null) {
    g.costKnown = false
  } else {
    g.costUsd += call.costUsd
  }
}

export default async function CostPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params

  const db = getDb()
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!run) notFound()

  const calls = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId))

  const byStage = new Map<string, Group>()
  const byTier = new Map<string, Group>()
  const total = emptyGroup()

  for (const call of calls) {
    addCall(total, call)
    if (!byStage.has(call.stage)) byStage.set(call.stage, emptyGroup())
    addCall(byStage.get(call.stage)!, call)
    if (!byTier.has(call.tier)) byTier.set(call.tier, emptyGroup())
    addCall(byTier.get(call.tier)!, call)
  }

  // §7's counterfactual: same token counts, priced as if every call had gone
  // to Ultra instead of its actual tier. Only counts calls whose Ultra-priced
  // cost is computable (Ultra has a pricing entry — see config/pricing.json).
  let counterfactualUltraUsd = 0
  let counterfactualKnown = calls.length > 0
  for (const call of calls) {
    const estimate = estimateCostUsd(NEMOTRON_MODELS.ultra, call.promptTokens, call.completionTokens)
    if (estimate == null) {
      counterfactualKnown = false
      continue
    }
    counterfactualUltraUsd += estimate.costUsd
  }

  const savedPct =
    counterfactualKnown && total.costKnown && counterfactualUltraUsd > 0
      ? ((counterfactualUltraUsd - total.costUsd) / counterfactualUltraUsd) * 100
      : null

  const ultraCalls = byTier.get("ultra")?.calls ?? 0
  const ultraSharePct = calls.length > 0 ? (ultraCalls / calls.length) * 100 : 0

  const filtered = run.stats?.filtered ?? null
  const pricesConfirmed = arePricesConfirmed([...new Set(calls.map((c) => c.modelId))])

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <div>
        <Link href={`/runs/${runId}`} className="text-sm text-muted-foreground hover:underline">
          ← Back to run
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Cost</h1>
        <p className="text-sm text-muted-foreground">
          {run.repoUrl} · every LLM call this run made, grouped by stage and tier.
        </p>
      </header>

      {calls.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No LLM calls recorded for this run yet.
          </CardContent>
        </Card>
      ) : (
        <>
          {pricesConfirmed ? (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              Prices confirmed against the real Nebius dashboard — see{" "}
              <code className="rounded bg-black/5 px-1 py-0.5 font-mono dark:bg-white/10">config/pricing.json</code>.
            </div>
          ) : (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Prices are third-party-sourced (not confirmed against the real Nebius dashboard) — see{" "}
              <code className="rounded bg-black/5 px-1 py-0.5 font-mono dark:bg-white/10">config/pricing.json</code>.
              Treat totals below as directional, not exact.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Total calls" value={calls.length.toLocaleString()} />
            <Stat label="Total spend" value={total.costKnown ? fmtUsd(total.costUsd) : "unknown"} />
            <Stat label="Filtered pre-inference" value={filtered != null ? filtered.toLocaleString() : "—"} />
            <Stat label="Ultra share of calls" value={`${ultraSharePct.toFixed(1)}%`} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">All-Ultra counterfactual</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">
                What this run would have cost if every call — including triage and DS descriptions —
                had been routed to Ultra instead of its actual tier, at the same token counts.
              </p>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <div>
                  <span className="text-xs text-muted-foreground">Actual: </span>
                  <span className="font-semibold tabular-nums">{total.costKnown ? fmtUsd(total.costUsd) : "unknown"}</span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">All-Ultra: </span>
                  <span className="font-semibold tabular-nums">
                    {counterfactualKnown ? fmtUsd(counterfactualUltraUsd) : "unknown"}
                  </span>
                </div>
                {savedPct != null && (
                  <div>
                    <span className="text-xs text-muted-foreground">Saved: </span>
                    <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {savedPct.toFixed(1)}%
                    </span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By tier</CardTitle>
            </CardHeader>
            <CardContent>
              <GroupTable rows={TIER_ORDER.filter((t) => byTier.has(t)).map((t) => [t, byTier.get(t)!] as const)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By stage</CardTitle>
            </CardHeader>
            <CardContent>
              <GroupTable
                rows={[...byStage.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd)}
              />
            </CardContent>
          </Card>
        </>
      )}
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function GroupTable({ rows }: { rows: (readonly [string, Group])[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Calls</th>
            <th className="py-2 pr-4 font-medium">Prompt tokens</th>
            <th className="py-2 pr-4 font-medium">Completion tokens</th>
            <th className="py-2 font-medium">Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, g]) => (
            <tr key={name} className="border-b last:border-0">
              <td className="py-2 pr-4">
                <Badge variant="secondary">{name}</Badge>
              </td>
              <td className="py-2 pr-4 tabular-nums">{g.calls.toLocaleString()}</td>
              <td className="py-2 pr-4 tabular-nums">{fmtTokens(g.promptTokens)}</td>
              <td className="py-2 pr-4 tabular-nums">{fmtTokens(g.completionTokens)}</td>
              <td className="py-2 tabular-nums">{g.costKnown ? fmtUsd(g.costUsd) : "unknown"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

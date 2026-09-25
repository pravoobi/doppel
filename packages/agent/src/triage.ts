/**
 * §5.4 — Nemotron Nano, batched. Batching 20 per call matters: per-call overhead
 * dominates at this volume (CLAUDE.md §5.4). Drops anything below MIN_CONFIDENCE.
 */

import type { DsComponent, ShortlistedCandidate } from "@doppel/shared"
import { z } from "zod"
import { loadPrompt } from "./prompts"
import { route } from "./route"
import { TriageResultSchema, type TriageResult } from "./schemas"

const BATCH_SIZE = 20
const MIN_CONFIDENCE = 0.4

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function triageCandidates(
  candidates: ShortlistedCandidate[],
  dsComponents: DsComponent[],
  opts: { runId?: string } = {}
): Promise<TriageResult[]> {
  const componentsByName = new Map(dsComponents.map((c) => [c.name, c]))
  const results: TriageResult[] = []

  for (const batch of chunk(candidates, BATCH_SIZE)) {
    const relevantNames = [...new Set(batch.flatMap((c) => c.shortlist))]
    const componentDescriptions = relevantNames
      .map((name) => {
        const c = componentsByName.get(name)
        const desc = c?.description?.trim()
        return `- ${name}: ${desc && desc.length > 0 ? desc : "(no description yet)"}`
      })
      .join("\n")

    const candidatesJson = JSON.stringify(
      batch.map((c) => ({
        id: c.id,
        rootTag: c.fingerprint.rootTag,
        classTokens: c.fingerprint.classTokens,
        ariaRole: c.fingerprint.ariaRole,
        hasHandler: c.fingerprint.hasHandler,
        textSample: c.fingerprint.textSample,
        shortlist: c.shortlist,
      })),
      null,
      2
    )

    const user = loadPrompt("triage", { componentDescriptions, candidates: candidatesJson })

    const batchResults = await route({
      tier: "nano",
      stage: "triage",
      runId: opts.runId,
      user,
      schema: z.array(TriageResultSchema),
      schemaName: "TriageBatch",
    })

    results.push(...batchResults.filter((r) => r.confidence >= MIN_CONFIDENCE))
  }

  return results
}

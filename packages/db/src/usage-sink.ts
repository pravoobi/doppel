/**
 * A Drizzle-backed implementation of @doppel/agent's `UsageSink` interface —
 * structurally compatible, not imported, so packages/db and packages/agent
 * stay independent of each other. The orchestrator (whichever package ends up
 * calling both) is the integration point: `setUsageSink(new
 * DrizzleUsageSink(db, runId))` before running a pipeline against a real run.
 *
 * Mirrors @doppel/agent/src/usage-log.ts's `LlmCallInput` shape exactly —
 * duplicated intentionally rather than a cross-package type dependency, same
 * reasoning as this package's own `PropMappingEntry` (schema.ts).
 */

import { estimateCostUsd, type Tier } from "@doppel/shared"
import type { Database } from "./client"
import { llmCalls } from "./schema"

export type LlmCallInput = {
  runId?: string
  findingId?: string
  stage: string
  modelId: string
  tier: string
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  latencyMs: number
  attempt: number
}

const KNOWN_TIERS: readonly Tier[] = ["nano", "super", "ultra"]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class DrizzleUsageSink {
  constructor(
    private readonly db: Database,
    /** Fallback run ID when a call site doesn't supply its own (matches usage-log.ts's optional `runId`). */
    private readonly defaultRunId?: string
  ) {}

  async log(input: LlmCallInput): Promise<void> {
    const runId = input.runId ?? this.defaultRunId
    if (!runId) {
      throw new Error(
        `DrizzleUsageSink: no runId on the call (stage=${input.stage}) and no defaultRunId configured — ` +
          "llm_calls.run_id is NOT NULL, this would violate the schema, not just log incorrectly."
      )
    }
    if (!KNOWN_TIERS.includes(input.tier as Tier)) {
      throw new Error(`DrizzleUsageSink: unknown tier "${input.tier}" — the tier column is an enum, this would fail at insert.`)
    }
    if (input.findingId !== undefined && !UUID_RE.test(input.findingId)) {
      throw new Error(
        `DrizzleUsageSink: findingId "${input.findingId}" is not a UUID (stage=${input.stage}) — ` +
          "llm_calls.finding_id is a uuid column; pass a real findings.id or omit it entirely."
      )
    }

    const cost = estimateCostUsd(input.modelId, input.promptTokens, input.completionTokens)

    await this.db.insert(llmCalls).values({
      runId,
      findingId: input.findingId,
      stage: input.stage,
      modelId: input.modelId,
      tier: input.tier as Tier,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      latencyMs: input.latencyMs,
      costUsd: cost?.costUsd ?? null,
    })
  }
}

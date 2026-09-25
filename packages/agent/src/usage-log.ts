/**
 * Usage logging: CLAUDE.md §15 "Every LLM call writes a row to llm_calls before
 * returning. No exceptions" and §6's `llm_calls` table shape.
 *
 * `JsonlUsageSink` below is the default and remains useful standalone (e.g.
 * `pnpm m2-pipeline`/`m3-pipeline` have no run/database context to write
 * against). For a real dashboard run, the orchestrator calls `setUsageSink(new
 * DrizzleUsageSink(db, runId))` (from @doppel/db) before running the pipeline —
 * see that package's usage-sink.ts. Same row shape either way, by design.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { estimateCostUsd } from "@doppel/shared"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../..")
const LOG_DIR = path.join(REPO_ROOT, ".doppel")
const LOG_FILE = path.join(LOG_DIR, "llm_calls.jsonl")

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

export type LlmCallRecord = LlmCallInput & {
  costUsd: number | null
  costConfirmed: boolean | null
  timestamp: string
}

export interface UsageSink {
  log(input: LlmCallInput): Promise<void>
}

export class JsonlUsageSink implements UsageSink {
  async log(input: LlmCallInput): Promise<void> {
    const cost = estimateCostUsd(input.modelId, input.promptTokens, input.completionTokens)
    const record: LlmCallRecord = {
      ...input,
      costUsd: cost?.costUsd ?? null,
      costConfirmed: cost?.confirmed ?? null,
      timestamp: new Date().toISOString(),
    }
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf8")
  }
}

let sink: UsageSink = new JsonlUsageSink()

/** Swap the sink (e.g. in tests, or for a future Drizzle-backed implementation). */
export function setUsageSink(newSink: UsageSink): void {
  sink = newSink
}

export function logLlmCall(input: LlmCallInput): Promise<void> {
  return sink.log(input)
}

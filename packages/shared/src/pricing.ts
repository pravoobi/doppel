/**
 * Cost estimation from config/pricing.json. CLAUDE.md §3.1: every price in that
 * file is third-party-sourced and marked `confirmed: false` pending verification
 * against the real Nebius dashboard — see docs/DECISIONS.md. Costs computed here
 * inherit that uncertainty; the cost panel (§7, M4) must surface it, not hide it.
 *
 * Lives in @doppel/shared (not @doppel/agent, where it started) because both
 * agent's JSONL usage sink and @doppel/db's Drizzle-backed one need identical
 * cost math — duplicating it would mean the two sinks could silently disagree
 * on a run's cost.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRICING_PATH = path.resolve(__dirname, "../../../config/pricing.json")

export type Tier = "nano" | "super" | "ultra"

type PricingEntry = {
  tier: string
  input?: number | null
  output?: number | null
  blended?: number | null
  confirmed: boolean
}

type PricingFile = {
  unit: "per_1m_tokens"
  models: Record<string, PricingEntry>
}

let cached: PricingFile | null = null

function loadPricing(): PricingFile {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(PRICING_PATH, "utf8")) as PricingFile
  }
  return cached
}

export type CostEstimate = {
  costUsd: number
  confirmed: boolean
}

/** Returns null when the model has no pricing entry at all — never a guessed number. */
export function estimateCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number
): CostEstimate | null {
  const entry = loadPricing().models[modelId]
  if (!entry) return null

  if (entry.input != null && entry.output != null) {
    const costUsd = (promptTokens / 1_000_000) * entry.input + (completionTokens / 1_000_000) * entry.output
    return { costUsd, confirmed: entry.confirmed }
  }

  if (entry.blended != null) {
    const costUsd = ((promptTokens + completionTokens) / 1_000_000) * entry.blended
    return { costUsd, confirmed: entry.confirmed }
  }

  return null
}

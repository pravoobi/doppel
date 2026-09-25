/**
 * Model IDs pinned verbatim from `GET /v1/models` against the live Nebius Token
 * Factory API. CLAUDE.md §3.1: never hardcode a model ID anywhere else in the
 * codebase — everything routes through here.
 *
 * Confirmed 2026-09-23 (docs/DECISIONS.md has the full spike output). Four
 * Nemotron models are live, not three — Nano and Lightning are both distinct,
 * separately-billed models, where CLAUDE.md §3.1's table treated "Nano / Lightning"
 * as one uncertain row.
 */

export const NEMOTRON_MODELS = {
  nano: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  lightning: "nvidia/Nemotron-3_5-Lightning",
  super: "nvidia/nemotron-3-super-120b-a12b",
  ultra: "nvidia/Nemotron-3-Ultra-550b-a55b",
} as const

export type ModelTier = "nano" | "super" | "ultra"

/**
 * Pipeline stage → tier (CLAUDE.md §2, §5.4-§5.6). "nano" is used for the triage
 * tier because it matches the spec's own vocabulary throughout ("Nemotron Nano,
 * batched" — §5.4). "lightning" is a confirmed, live alternative for that same
 * cheap tier but is not wired to any stage — revisit only if Nano's triage
 * accuracy or latency proves inadequate once M2 has real batches to measure.
 */
export const TIER_MODEL: Record<ModelTier, string> = {
  nano: NEMOTRON_MODELS.nano,
  super: NEMOTRON_MODELS.super,
  ultra: NEMOTRON_MODELS.ultra,
}

/**
 * All four confirmed models are reasoning models — every completion response
 * carries non-null `completion_tokens_details.reasoning_tokens`, billed as
 * ordinary completion tokens. See docs/DECISIONS.md for what this means for
 * `max_tokens` budgets and cost telemetry (§7) before writing route.ts.
 */
export const REASONING_MODELS = new Set<string>(Object.values(NEMOTRON_MODELS))

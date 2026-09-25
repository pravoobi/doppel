import { describe, expect, it } from "vitest"
import { estimateCostUsd, arePricesConfirmed } from "../src/pricing.js"

describe("estimateCostUsd", () => {
  it("computes input+output cost for a model with a split price", () => {
    const result = estimateCostUsd("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 1_000_000, 1_000_000)
    // $0.06/1M input + $0.24/1M output per config/pricing.json
    expect(result).not.toBeNull()
    expect(result!.costUsd).toBeCloseTo(0.06 + 0.24, 10)
    expect(result!.confirmed).toBe(true)
  })

  it("scales linearly with token count, not a flat per-call fee", () => {
    const small = estimateCostUsd("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 1000, 500)!
    const large = estimateCostUsd("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 10_000, 5000)!
    expect(large.costUsd).toBeCloseTo(small.costUsd * 10, 10)
  })

  it("prefers a real input/output split over a blended rate when a model has both", () => {
    // Lightning's entry has both — the real dashboard-confirmed split (2026-09-25) is
    // more precise than the earlier blended-only estimate, so the split wins. The
    // blended branch (config/pricing.json entries with `blended` but no `input`/
    // `output`) has no current real-world example now that every entry is fully
    // confirmed, but the code path itself still exists for a future model that only
    // publishes a blended rate — see estimateCostUsd's `if (entry.blended != null)`.
    const result = estimateCostUsd("nvidia/Nemotron-3_5-Lightning", 500_000, 500_000)
    expect(result).not.toBeNull()
    expect(result!.costUsd).toBeCloseTo(0.5 * 0.06 + 0.5 * 0.24, 10)
  })

  it("returns null (never a guessed number) for a model with no pricing entry", () => {
    const result = estimateCostUsd("some/unpriced-model", 1000, 1000)
    expect(result).toBeNull()
  })

  it("marks every current entry as confirmed against the real Nebius dashboard, per config/pricing.json's own $note", () => {
    for (const modelId of [
      "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/Nemotron-3-Ultra-550b-a55b",
    ]) {
      const result = estimateCostUsd(modelId, 1000, 1000)
      expect(result?.confirmed).toBe(true)
    }
  })
})

describe("arePricesConfirmed", () => {
  it("is true when every given model is confirmed", () => {
    expect(arePricesConfirmed(["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "nvidia/Nemotron-3-Ultra-550b-a55b"])).toBe(true)
  })

  it("is false when any given model has no pricing entry at all", () => {
    expect(arePricesConfirmed(["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "some/unpriced-model"])).toBe(false)
  })

  it("is true for an empty list — vacuously, nothing is unconfirmed", () => {
    expect(arePricesConfirmed([])).toBe(true)
  })
})

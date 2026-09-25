import { describe, expect, it } from "vitest"
import { estimateCostUsd } from "../src/pricing.js"

describe("estimateCostUsd", () => {
  it("computes input+output cost for a model with a split price", () => {
    const result = estimateCostUsd("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 1_000_000, 1_000_000)
    // $0.06/1M input + $0.24/1M output per config/pricing.json
    expect(result).not.toBeNull()
    expect(result!.costUsd).toBeCloseTo(0.06 + 0.24, 10)
    expect(result!.confirmed).toBe(false)
  })

  it("scales linearly with token count, not a flat per-call fee", () => {
    const small = estimateCostUsd("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 1000, 500)!
    const large = estimateCostUsd("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 10_000, 5000)!
    expect(large.costUsd).toBeCloseTo(small.costUsd * 10, 10)
  })

  it("falls back to a blended rate for a model with no input/output split", () => {
    const result = estimateCostUsd("nvidia/Nemotron-3_5-Lightning", 500_000, 500_000)
    // $0.08/1M blended per config/pricing.json — total tokens, not input+output separately
    expect(result).not.toBeNull()
    expect(result!.costUsd).toBeCloseTo(0.08, 10)
  })

  it("returns null (never a guessed number) for a model with no pricing entry", () => {
    const result = estimateCostUsd("some/unpriced-model", 1000, 1000)
    expect(result).toBeNull()
  })

  it("marks every current entry as unconfirmed, per config/pricing.json's own $note", () => {
    for (const modelId of [
      "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/Nemotron-3-Ultra-550b-a55b",
    ]) {
      const result = estimateCostUsd(modelId, 1000, 1000)
      expect(result?.confirmed).toBe(false)
    }
  })
})

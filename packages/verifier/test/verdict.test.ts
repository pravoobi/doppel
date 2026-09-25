import { describe, expect, it } from "vitest"
import { computeVerdict, type Thresholds } from "../src/verdict.js"
import type { VerificationInput } from "@doppel/shared"

const thresholds: Thresholds = { passMaxDeltaRatio: 0.005, reviewMaxDeltaRatio: 0.05 }

function baseInput(overrides: Partial<VerificationInput> = {}): VerificationInput {
  return {
    renderable: true,
    typecheckPassed: true,
    lintPassed: true,
    viewportResults: [{ viewport: 375, deltaRatio: 0 }],
    ...overrides,
  }
}

describe("computeVerdict", () => {
  it("returns UNVERIFIABLE when the component couldn't render, regardless of anything else", () => {
    const input = baseInput({ renderable: false, typecheckPassed: false, lintPassed: false })
    expect(computeVerdict(input, thresholds)).toBe("UNVERIFIABLE")
  })

  it("returns UNVERIFIABLE when there are no viewport results to judge", () => {
    const input = baseInput({ viewportResults: [] })
    expect(computeVerdict(input, thresholds)).toBe("UNVERIFIABLE")
  })

  it("returns FAIL on a typecheck failure even with pixel-perfect rendering", () => {
    const input = baseInput({ typecheckPassed: false })
    expect(computeVerdict(input, thresholds)).toBe("FAIL")
  })

  it("returns FAIL on a lint failure even with pixel-perfect rendering", () => {
    const input = baseInput({ lintPassed: false })
    expect(computeVerdict(input, thresholds)).toBe("FAIL")
  })

  it("returns PASS at or below the pass threshold", () => {
    const input = baseInput({ viewportResults: [{ viewport: 375, deltaRatio: 0.005 }] })
    expect(computeVerdict(input, thresholds)).toBe("PASS")
  })

  it("returns REVIEW between the pass and review thresholds", () => {
    const input = baseInput({ viewportResults: [{ viewport: 375, deltaRatio: 0.02 }] })
    expect(computeVerdict(input, thresholds)).toBe("REVIEW")
  })

  it("returns REVIEW at exactly the review threshold", () => {
    const input = baseInput({ viewportResults: [{ viewport: 375, deltaRatio: 0.05 }] })
    expect(computeVerdict(input, thresholds)).toBe("REVIEW")
  })

  it("returns FAIL above the review threshold", () => {
    const input = baseInput({ viewportResults: [{ viewport: 375, deltaRatio: 0.06 }] })
    expect(computeVerdict(input, thresholds)).toBe("FAIL")
  })

  it("uses the WORST viewport, not the best or the average (§5.7 step 5)", () => {
    const input = baseInput({
      viewportResults: [
        { viewport: 375, deltaRatio: 0.001 },
        { viewport: 768, deltaRatio: 0.001 },
        { viewport: 1440, deltaRatio: 0.2 }, // one bad viewport should fail the whole finding
      ],
    })
    expect(computeVerdict(input, thresholds)).toBe("FAIL")
  })

  it("loadThresholdsFromEnv reads CLAUDE.md §16's documented env vars with matching defaults", async () => {
    const { loadThresholdsFromEnv } = await import("../src/verdict.js")
    delete process.env.DOPPEL_PIXEL_PASS_THRESHOLD
    delete process.env.DOPPEL_PIXEL_REVIEW_THRESHOLD
    expect(loadThresholdsFromEnv()).toEqual({ passMaxDeltaRatio: 0.005, reviewMaxDeltaRatio: 0.05 })

    process.env.DOPPEL_PIXEL_PASS_THRESHOLD = "0.01"
    process.env.DOPPEL_PIXEL_REVIEW_THRESHOLD = "0.1"
    expect(loadThresholdsFromEnv()).toEqual({ passMaxDeltaRatio: 0.01, reviewMaxDeltaRatio: 0.1 })
    delete process.env.DOPPEL_PIXEL_PASS_THRESHOLD
    delete process.env.DOPPEL_PIXEL_REVIEW_THRESHOLD
  })
})

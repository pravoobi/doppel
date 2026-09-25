import { describe, expect, it } from "vitest"
import { buildPrBody, type PrBodyFinding } from "../src/pr-body"

function finding(overrides: Partial<PrBodyFinding> = {}): PrBodyFinding {
  return {
    file: "app/page.tsx",
    line: 10,
    matchedComponent: "Button",
    verdict: "PASS",
    deltaRatio: 0.001,
    beforeImageUrl: null,
    afterImageUrl: null,
    diffImageUrl: null,
    ...overrides,
  }
}

describe("buildPrBody", () => {
  it("includes a table row per finding with file:line, verdict, and delta as a percentage", () => {
    const body = buildPrBody([finding({ deltaRatio: 0.0123 })], "run-1")
    expect(body).toContain("app/page.tsx:10")
    expect(body).toContain("PASS")
    expect(body).toContain("1.23%")
  })

  it("groups findings under a heading per matched component", () => {
    const body = buildPrBody(
      [finding({ matchedComponent: "Button" }), finding({ matchedComponent: "Card", file: "app/other.tsx" })],
      "run-1"
    )
    expect(body).toContain("### Button")
    expect(body).toContain("### Card")
  })

  it("falls back to a placeholder heading when matchedComponent is null", () => {
    const body = buildPrBody([finding({ matchedComponent: null })], "run-1")
    expect(body).toContain("(unmatched)")
  })

  it("renders image tags only when all three URLs are present", () => {
    const withImages = buildPrBody(
      [finding({ beforeImageUrl: "https://x/before.png", afterImageUrl: "https://x/after.png", diffImageUrl: "https://x/diff.png" })],
      "run-1"
    )
    expect(withImages).toContain("https://x/before.png")
    expect(withImages).toContain("https://x/after.png")
    expect(withImages).toContain("https://x/diff.png")

    const withoutImages = buildPrBody([finding()], "run-1")
    expect(withoutImages).not.toContain("<img")
  })

  it("shows an em-dash when deltaRatio is null rather than a fabricated number", () => {
    const body = buildPrBody([finding({ deltaRatio: null })], "run-1")
    expect(body).toMatch(/\|\s*—\s*\|/)
  })

  it("includes the run id somewhere in the body for traceability", () => {
    const body = buildPrBody([finding()], "run-abc123")
    expect(body).toContain("run-abc123")
  })
})

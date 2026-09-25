import { describe, expect, it, vi } from "vitest"
import { DrizzleUsageSink } from "../src/usage-sink.js"
import type { Database } from "../src/client.js"

function fakeDb(valuesImpl: (vals: unknown) => Promise<unknown> = async () => undefined) {
  const values = vi.fn(valuesImpl)
  const insert = vi.fn(() => ({ values }))
  const db = { insert } as unknown as Database
  return { db, insert, values }
}

const baseInput = {
  stage: "triage",
  modelId: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  tier: "nano",
  promptTokens: 100,
  completionTokens: 50,
  reasoningTokens: 20,
  latencyMs: 500,
  attempt: 1,
}

describe("DrizzleUsageSink", () => {
  it("inserts a row using the call's own runId when present", async () => {
    const { db, values } = fakeDb()
    const sink = new DrizzleUsageSink(db)
    await sink.log({ ...baseInput, runId: "run-1" })
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", stage: "triage" }))
  })

  it("falls back to the constructor's defaultRunId when the call has none", async () => {
    const { db, values } = fakeDb()
    const sink = new DrizzleUsageSink(db, "default-run")
    await sink.log(baseInput)
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ runId: "default-run" }))
  })

  it("throws rather than silently inserting a NULL run_id when neither is set", async () => {
    const { db } = fakeDb()
    const sink = new DrizzleUsageSink(db)
    await expect(sink.log(baseInput)).rejects.toThrow(/runId/)
  })

  it("throws on an unrecognized tier instead of letting the DB enum constraint fail opaquely", async () => {
    const { db } = fakeDb()
    const sink = new DrizzleUsageSink(db, "run-1")
    await expect(sink.log({ ...baseInput, tier: "medium" })).rejects.toThrow(/tier/)
  })

  it("carries findingId through when present as a real UUID, and omits it (undefined, not null) when absent", async () => {
    const { db, values } = fakeDb()
    const sink = new DrizzleUsageSink(db, "run-1")
    const findingId = "3f6e2c5e-6a3f-4b3e-9c1a-2b7e4f9c5d1a"

    await sink.log({ ...baseInput, findingId })
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ findingId }))

    await sink.log(baseInput)
    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ findingId: undefined }))
  })

  it("throws on a non-UUID findingId instead of letting the DB uuid constraint fail opaquely", async () => {
    // Regression test: packages/agent's adjudicate/migrate/repair stages used
    // to pass their scanner-internal candidateId (e.g. "c6") straight through
    // as findingId — harmless against JsonlUsageSink, but an "invalid input
    // syntax for type uuid" error the first time this ran against real
    // Postgres. See docs/DECISIONS.md.
    const { db } = fakeDb()
    const sink = new DrizzleUsageSink(db, "run-1")
    await expect(sink.log({ ...baseInput, findingId: "c6" })).rejects.toThrow(/findingId/)
  })

  it("computes costUsd via the shared pricing table for a known model", async () => {
    const { db, values } = fakeDb()
    const sink = new DrizzleUsageSink(db, "run-1")
    await sink.log(baseInput)
    const call = values.mock.calls[0][0] as { costUsd: number | null }
    // nano is priced in config/pricing.json — exact figure isn't this test's
    // concern (that's pricing.test.ts in @doppel/shared), just that it's a
    // real computed number, not null/undefined for a model that IS priced.
    expect(typeof call.costUsd).toBe("number")
  })
})

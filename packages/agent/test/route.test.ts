/**
 * Unit tests for route.ts against a mocked OpenAI client — no network, no cost.
 * Covers the retry-then-hard-fail contract from CLAUDE.md §15.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type OpenAI from "openai"
import { route, RouteError, setClientForTesting } from "../src/route.js"
import { setUsageSink, type UsageSink } from "../src/usage-log.js"

const Schema = z.object({ answer: z.string() })

function fakeClient(create: (...args: unknown[]) => Promise<unknown>): OpenAI {
  return {
    chat: { completions: { create } },
    // Only the subset route.ts actually calls is implemented — cast is test-only.
  } as unknown as OpenAI
}

function completion(content: string | null) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  }
}

class NoopSink implements UsageSink {
  calls: unknown[] = []
  async log(input: unknown) {
    this.calls.push(input)
  }
}

describe("route()", () => {
  let sink: NoopSink

  beforeEach(() => {
    process.env.NEBIUS_API_KEY = "test-key"
    sink = new NoopSink()
    setUsageSink(sink)
  })

  it("returns the parsed result on a valid first response", async () => {
    const create = vi.fn().mockResolvedValue(completion(JSON.stringify({ answer: "ok" })))
    setClientForTesting(fakeClient(create))

    const result = await route({
      tier: "nano",
      stage: "test",
      user: "hi",
      schema: Schema,
      schemaName: "Test",
    })

    expect(result).toEqual({ answer: "ok" })
    expect(create).toHaveBeenCalledTimes(1)
    expect(sink.calls).toHaveLength(1)
  })

  it("retries once with a clarifying message when content is null, then succeeds", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(completion(null))
      .mockResolvedValueOnce(completion(JSON.stringify({ answer: "ok" })))
    setClientForTesting(fakeClient(create))

    const result = await route({
      tier: "nano",
      stage: "test",
      user: "hi",
      schema: Schema,
      schemaName: "Test",
    })

    expect(result).toEqual({ answer: "ok" })
    expect(create).toHaveBeenCalledTimes(2)
    const secondCallArgs = create.mock.calls[1][0] as { messages: Array<{ content: string }> }
    expect(secondCallArgs.messages.at(-1)?.content).toMatch(/previous response was invalid/i)
    expect(sink.calls).toHaveLength(2)
  })

  it("retries once on a schema-invalid response, then succeeds", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(completion(JSON.stringify({ wrong: "shape" })))
      .mockResolvedValueOnce(completion(JSON.stringify({ answer: "ok" })))
    setClientForTesting(fakeClient(create))

    const result = await route({
      tier: "super",
      stage: "test",
      user: "hi",
      schema: Schema,
      schemaName: "Test",
    })

    expect(result).toEqual({ answer: "ok" })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it("throws RouteError after exhausting attempts, never falls back silently", async () => {
    const create = vi.fn().mockResolvedValue(completion("not json"))
    setClientForTesting(fakeClient(create))

    await expect(
      route({ tier: "ultra", stage: "test", user: "hi", schema: Schema, schemaName: "Test" })
    ).rejects.toThrow(RouteError)

    expect(create).toHaveBeenCalledTimes(2)
    expect(sink.calls).toHaveLength(2)
  })

  it("logs a row for every attempt, not just the final one", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(completion(null))
      .mockResolvedValueOnce(completion(JSON.stringify({ answer: "ok" })))
    setClientForTesting(fakeClient(create))

    await route({ tier: "nano", stage: "triage", user: "hi", schema: Schema, schemaName: "Test" })

    expect(sink.calls).toEqual([
      expect.objectContaining({ stage: "triage", attempt: 1 }),
      expect.objectContaining({ stage: "triage", attempt: 2 }),
    ])
  })
})

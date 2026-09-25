/**
 * Unit tests for the polling/error-handling logic in sandbox.ts, against a
 * mocked `fetch` — no real network or Sandboxes credits spent. The actual
 * request/response SHAPES this mock returns are exactly what was observed live
 * (see docs/DECISIONS.md, "Sandboxes beta access granted"); this test locks in
 * the client's behavior around those shapes, not the shapes themselves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SandboxApiError, SandboxClient, SandboxTimeoutError } from "../src/sandbox.js"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("SandboxClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const client = () => new SandboxClient({ apiKey: "test-key", projectId: "test-project" })

  it("whoami sends the confirmed auth headers and returns the parsed body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token_uuid: "abc", permissions: { spawn: true } })
    )
    const result = await client().whoami()
    expect(result.token_uuid).toBe("abc")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("/whoami")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key")
    expect((init.headers as Record<string, string>).Project).toBe("test-project")
  })

  it("whoami throws SandboxApiError with status/body on failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "nope" }))
    await expect(client().whoami()).rejects.toThrow(SandboxApiError)
  })

  it("spawnInstance returns just the uuid — result is always null at this point", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { uuid: "op-1", result: null }))
    const uuid = await client().spawnInstance({ image: "tag:ubuntu:latest", command: "echo hi" })
    expect(uuid).toBe("op-1")
  })

  it("pollOperation returns immediately on a terminal status from the first poll", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        uuid: "op-1",
        status: "SUCCESS",
        error: null,
        result: { image: "img-after-echo", tag: null },
        metadata: {
          result: {
            state: { exit_code: 0, timed_out: false },
            stdout: { value: "hello\n", truncated: false },
            stderr: { value: "", truncated: false },
          },
        },
      })
    )
    const result = await client().pollOperation("op-1", 5000, 1)
    expect(result).toMatchObject({ status: "SUCCESS", exitCode: 0, stdout: "hello\n" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("decodes stdout/stderr when the API marks them base64-encoded", async () => {
    // Found live: large output (a base64 PNG embedded in stdout) came back
    // with the WHOLE stdout value itself re-encoded as base64, `encoding:
    // "base64"` — distinct from the plain "ascii" encoding small output uses.
    // Missing this doesn't error, it just returns unparseable text.
    const realText = "DOPPEL_SCREENSHOT:375:iVBORw0KGgo...\nDOPPEL_SHOOT_DONE\n"
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        uuid: "op-1",
        status: "SUCCESS",
        error: null,
        metadata: {
          result: {
            state: { exit_code: 0, timed_out: false },
            stdout: { value: Buffer.from(realText, "utf8").toString("base64"), encoding: "base64", truncated: false },
            stderr: { value: "", encoding: "ascii", truncated: false },
          },
        },
      })
    )
    const result = await client().pollOperation("op-1", 5000, 1)
    expect(result.stdout).toBe(realText)
  })

  it("leaves stdout literal when the API marks it ascii-encoded (the common case)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        uuid: "op-1",
        status: "SUCCESS",
        error: null,
        metadata: {
          result: {
            state: { exit_code: 0, timed_out: false },
            stdout: { value: "hello\n", encoding: "ascii", truncated: false },
          },
        },
      })
    )
    const result = await client().pollOperation("op-1", 5000, 1)
    expect(result.stdout).toBe("hello\n")
  })

  it("pollOperation surfaces resultImageUuid for chaining the next spawn (§3.3 branching)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        uuid: "op-1",
        status: "SUCCESS",
        error: null,
        result: { image: "img-checkpoint-abc", tag: null },
        metadata: { result: { state: { exit_code: 0, timed_out: false } } },
      })
    )
    const result = await client().pollOperation("op-1", 5000, 1)
    expect(result.resultImageUuid).toBe("img-checkpoint-abc")
  })

  it("pollOperation polls through non-terminal statuses before returning", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { uuid: "op-1", status: "PENDING", error: null }))
      .mockResolvedValueOnce(jsonResponse(200, { uuid: "op-1", status: "EXECUTING", error: null }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          uuid: "op-1",
          status: "SUCCESS",
          error: null,
          metadata: { result: { state: { exit_code: 0, timed_out: false } } },
        })
      )
    const result = await client().pollOperation("op-1", 5000, 1)
    expect(result.status).toBe("SUCCESS")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("pollOperation surfaces FAILED as a terminal result, not an error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        uuid: "op-1",
        status: "FAILED",
        error: "command exited non-zero",
        metadata: { result: { state: { exit_code: 1, timed_out: false } } },
      })
    )
    const result = await client().pollOperation("op-1", 5000, 1)
    expect(result.status).toBe("FAILED")
    expect(result.exitCode).toBe(1)
  })

  it("pollOperation throws SandboxTimeoutError if it never reaches a terminal status", async () => {
    // mockResolvedValue (not mockResolvedValueOnce) reuses one Response instance across
    // calls — its body stream can only be read once, so it must be rebuilt per call.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { uuid: "op-1", status: "EXECUTING", error: null }))
    )
    await expect(client().pollOperation("op-1", 10, 1)).rejects.toThrow(SandboxTimeoutError)
  })

  it("runCommand spawns then polls in one call", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { uuid: "op-1", result: null }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          uuid: "op-1",
          status: "SUCCESS",
          error: null,
          metadata: { result: { state: { exit_code: 0, timed_out: false }, stdout: { value: "ok\n" } } },
        })
      )
    const result = await client().runCommand({ image: "tag:ubuntu:latest", command: "echo ok" })
    expect(result.stdout).toBe("ok\n")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

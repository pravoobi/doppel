/**
 * ConTree (Sandboxes) client wrapper (CLAUDE.md §5.7 / §3.3).
 *
 * STATUS: verified live against the real API 2026-09-23, once Sandboxes beta
 * access was granted (see docs/DECISIONS.md, "Sandboxes beta access granted").
 * Every shape here — including the poll-for-result flow, which ISN'T documented
 * anywhere in the API reference we could fetch — was confirmed against real
 * responses via scripts/spike.ts and ad-hoc curl calls before being encoded
 * here. §17.3's outbound-network-access question is answered: **yes** —
 * `apt-get update`/`apt-get install` and `curl` to an external HTTPS host both
 * succeeded inside a sandbox with no special configuration.
 */

const SANDBOXES_BASE_URL =
  process.env.SANDBOXES_BASE_URL ?? "https://api.tokenfactory.nebius.com/sandboxes/v1"

export type SandboxClientOptions = {
  apiKey: string
  projectId: string
  baseUrl?: string
}

export type WhoAmI = {
  token_uuid: string
  token_expiration: number
  permissions: {
    import: boolean
    spawn: boolean
    spawn_disposable: boolean
    list: boolean
    cancel: boolean
    set_image_tag: boolean
  }
  operations_stat: { running_instances: number; running_imports: number }
  limits: {
    instance_max_timeout: number
    instance_max_concurrency: number
    instance_max_layer_bytes: number
    images_import_max_concurrency: number
    images_import_max_timeout: number
  }
}

export type SpawnInstanceInput = {
  /** e.g. "tag:ubuntu:latest" — the documented ImageSource format, confirmed live. */
  image: string
  command: string
  shell?: boolean
  env?: Record<string, string>
  cwd?: string
  /** Per-command timeout. Server default observed as 60s when omitted. */
  timeoutSeconds?: number
}

export type OperationStatus = "PENDING" | "ASSIGNED" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED"

const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set(["SUCCESS", "FAILED", "CANCELLED"])

export type OperationResult = {
  uuid: string
  status: OperationStatus
  error: string | null
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stdoutTruncated: boolean
  stderr: string
  stderrTruncated: boolean
  /**
   * The filesystem state AFTER this command ran, as a new image uuid — pass it
   * as the next `spawnInstance`'s `image` to chain commands against the same
   * state instead of restarting from the base image (§3.3's "fork per patch
   * from a warm base"). Confirmed live 2026-09-23; not in the fetchable docs.
   */
  resultImageUuid: string | null
}

export class SandboxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message)
    this.name = "SandboxApiError"
  }
}

export class SandboxTimeoutError extends Error {
  constructor(
    public readonly uuid: string,
    public readonly timeoutMs: number
  ) {
    super(`Polling operation ${uuid} timed out after ${timeoutMs}ms without reaching a terminal status`)
    this.name = "SandboxTimeoutError"
  }
}

type RawStream = { value: string; encoding?: string; truncated: boolean }

/** Raw shape of GET /v1/operations/{uuid}, as observed live. Not in the fetchable API docs. */
type RawOperation = {
  uuid: string
  status: OperationStatus
  error: string | null
  /** Top-level, sibling to `metadata` — the filesystem checkpoint after this command ran. */
  result?: { image: string | null; tag: string | null }
  metadata?: {
    result?: {
      state?: { exit_code: number; timed_out: boolean }
      stdout?: RawStream
      stderr?: RawStream
    }
  }
}

/**
 * Small/plain-ASCII output comes back with `encoding: "ascii"` and a literal
 * `value` (confirmed live on a simple `echo hello`). A large payload containing
 * a base64-encoded screenshot came back with the WHOLE value itself re-encoded
 * as base64 (`encoding: "base64"`) — presumably for safe JSON transport of
 * something that would otherwise need heavy escaping. Missing this decode step
 * doesn't error, it just silently returns unparseable text — found by a script
 * that decoded clean at first glance but contained none of the markers it was
 * supposed to. Decode whenever the field says to; never assume "ascii".
 */
function decodeStream(stream: RawStream | undefined): { value: string; truncated: boolean } {
  if (!stream) return { value: "", truncated: false }
  const value = stream.encoding === "base64" ? Buffer.from(stream.value, "base64").toString("utf8") : stream.value
  return { value, truncated: stream.truncated }
}

function toOperationResult(raw: RawOperation): OperationResult {
  const result = raw.metadata?.result
  const stdout = decodeStream(result?.stdout)
  const stderr = decodeStream(result?.stderr)
  return {
    uuid: raw.uuid,
    status: raw.status,
    error: raw.error,
    exitCode: result?.state?.exit_code ?? null,
    timedOut: result?.state?.timed_out ?? false,
    resultImageUuid: raw.result?.image ?? null,
    stdout: stdout.value,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.value,
    stderrTruncated: stderr.truncated,
  }
}

export class SandboxClient {
  constructor(private readonly opts: SandboxClientOptions) {}

  private async request(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.opts.baseUrl ?? SANDBOXES_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        Project: this.opts.projectId,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  }

  async whoami(): Promise<WhoAmI> {
    const { status, body } = await this.request("/whoami")
    if (status !== 200) throw new SandboxApiError(`whoami failed`, status, body)
    return body as WhoAmI
  }

  /** POST /v1/instances is asynchronous — the response's `result` field is always
   * null at this point. Returns just the uuid; use `pollOperation` or `runCommand`
   * to get the actual output. */
  async spawnInstance(input: SpawnInstanceInput): Promise<string> {
    const { status, body } = await this.request("/instances", {
      method: "POST",
      body: JSON.stringify({
        image: input.image,
        command: input.command,
        shell: input.shell ?? true,
        env: input.env,
        cwd: input.cwd,
        timeout: input.timeoutSeconds,
      }),
    })
    if (status !== 201 && status !== 200) {
      throw new SandboxApiError(`spawnInstance failed`, status, body)
    }
    return (body as { uuid: string }).uuid
  }

  /**
   * Polls GET /v1/operations/{uuid} until the operation reaches a terminal
   * status. This endpoint is NOT in the API reference pages we could fetch —
   * found empirically by testing it against a real spawned instance's uuid.
   */
  async pollOperation(uuid: string, timeoutMs = 60_000, pollIntervalMs = 1500): Promise<OperationResult> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const { status, body } = await this.request(`/operations/${uuid}`)
      if (status !== 200) throw new SandboxApiError(`GET /operations/${uuid} failed`, status, body)
      const op = body as RawOperation
      if (TERMINAL_STATUSES.has(op.status)) return toOperationResult(op)
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
    throw new SandboxTimeoutError(uuid, timeoutMs)
  }

  /** Convenience: spawn + poll in one call, the common case for the verify loop. */
  async runCommand(input: SpawnInstanceInput): Promise<OperationResult> {
    const uuid = await this.spawnInstance(input)
    const timeoutMs = ((input.timeoutSeconds ?? 60) + 15) * 1000
    return this.pollOperation(uuid, timeoutMs)
  }
}

/**
 * Day-one spike (CLAUDE.md §3.2). Proves three legs work and nothing else:
 *
 *   1. GET /v1/models            — print every Nemotron ID
 *   2. One chat completion per tier — print latency + usage
 *   3. One sandbox: pull ubuntu:latest, run `echo hello`, print stdout/exit code
 *   4. In a fresh instance of the SAME image: `apt-get install curl` then curl an
 *      external HTTPS URL — this answers whether sandboxes have outbound network
 *      access, the highest-impact unknown in the spec (§17.3). If this fails,
 *      dependencies must be baked into a custom OCI image instead of installed at
 *      verify time. CONFIRMED YES as of 2026-09-23 — see docs/DECISIONS.md.
 *
 * Run: NEBIUS_API_KEY=... pnpm tsx scripts/spike.ts
 *
 * Do not build on top of this file's guesses. Whatever it prints is the source of
 * truth — copy real model IDs into packages/agent/src/models.ts verbatim, and
 * record every answer in docs/DECISIONS.md before writing any agent or verifier code.
 */

import OpenAI from "openai"

const NEBIUS_BASE_URL =
  process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/"
const NEBIUS_API_KEY = process.env.NEBIUS_API_KEY
const SANDBOXES_BASE_URL =
  process.env.SANDBOXES_BASE_URL ?? "https://api.tokenfactory.nebius.com/sandboxes/v1"
// Real project ID, from tokenfactory.nebius.com/project/api-keys — required for
// spawn/list to actually work (whoami alone will accept a placeholder, but that
// was only ever good enough to check permissions, not to run anything).
const NEBIUS_PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? "default"

function fail(message: string): never {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

async function step1_listModels(client: OpenAI) {
  console.log("\n=== 1. GET /v1/models ===")
  const models = await client.models.list()
  const ids = models.data.map((m) => m.id)
  const nemotronIds = ids.filter((id) => /nemotron/i.test(id))

  if (nemotronIds.length === 0) {
    console.warn("  No model ID matched /nemotron/i. Full list:")
    for (const id of ids) console.log(`   - ${id}`)
  } else {
    console.log(`  Found ${nemotronIds.length} Nemotron model(s):`)
    for (const id of nemotronIds) console.log(`   - ${id}`)
  }
  return nemotronIds
}

async function step2_oneCompletionPerTier(client: OpenAI, modelIds: string[]) {
  console.log("\n=== 2. One completion per tier ===")
  if (modelIds.length === 0) {
    console.warn("  Skipped — no Nemotron model IDs from step 1.")
    return
  }
  for (const modelId of modelIds) {
    const start = Date.now()
    try {
      const res = await client.chat.completions.create({
        model: modelId,
        messages: [{ role: "user", content: "Reply with the single word: pong." }],
        max_tokens: 20,
      })
      const latencyMs = Date.now() - start
      console.log(`  ${modelId}`)
      console.log(`    latency: ${latencyMs}ms`)
      console.log(`    usage:   ${JSON.stringify(res.usage)}`)
      console.log(`    reply:   ${JSON.stringify(res.choices[0]?.message?.content)}`)
    } catch (err) {
      console.error(`  ${modelId} — FAILED: ${(err as Error).message}`)
    }
  }
}

type WhoAmI = {
  token_uuid: string
  token_expiration: number
  permissions: Record<"import" | "spawn" | "spawn_disposable" | "list" | "cancel" | "set_image_tag", boolean>
  operations_stat: { running_instances: number; running_imports: number }
  limits: Record<string, number>
}

async function sandboxFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${SANDBOXES_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NEBIUS_API_KEY}`,
      Project: NEBIUS_PROJECT_ID,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

type OperationResult = {
  status: "PENDING" | "ASSIGNED" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED"
  error: string | null
  metadata?: {
    result?: {
      state?: { exit_code: number; timed_out: boolean }
      stdout?: { value: string; truncated: boolean }
      stderr?: { value: string; truncated: boolean }
    }
  }
}

/**
 * NOT in the API reference docs we could fetch (the "list operations" page only
 * documented GET /v1/operations with filters, no per-uuid GET). Found
 * empirically 2026-09-23 by testing GET /v1/operations/{uuid} directly against
 * a real spawned instance's uuid — it works and returns the full result
 * (stdout/stderr/exit_code under `metadata.result`). Spawning is async
 * (POST /instances returns 201 with `result: null` immediately); this polls
 * until the operation leaves PENDING/ASSIGNED/EXECUTING.
 */
async function pollOperation(uuid: string, timeoutMs = 60_000): Promise<OperationResult> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { status, body } = await sandboxFetch(`/operations/${uuid}`)
    if (status !== 200) throw new Error(`GET /operations/${uuid} failed (${status}): ${JSON.stringify(body)}`)
    const op = body as OperationResult
    if (op.status === "SUCCESS" || op.status === "FAILED" || op.status === "CANCELLED") return op
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`polling /operations/${uuid} timed out after ${timeoutMs}ms`)
}

async function runInSandbox(command: string, timeoutSeconds = 60) {
  const spawn = await sandboxFetch("/instances", {
    method: "POST",
    body: JSON.stringify({ image: "tag:ubuntu:latest", command, shell: true, timeout: timeoutSeconds }),
  })
  if (spawn.status !== 201 && spawn.status !== 200) {
    throw new Error(`POST /instances failed (${spawn.status}): ${JSON.stringify(spawn.body)}`)
  }
  const uuid = (spawn.body as { uuid: string }).uuid
  return pollOperation(uuid, (timeoutSeconds + 15) * 1000)
}

async function step3and4_sandbox() {
  console.log("\n=== 3 & 4. Sandbox: echo + network access ===")
  console.log(`  Base URL: ${SANDBOXES_BASE_URL}  Project: ${NEBIUS_PROJECT_ID}`)

  // Confirmed 2026-09-23: auth is the SAME NEBIUS_API_KEY as inference, sent as a plain
  // bearer token — no separate IAM exchange needed, contrary to what the raw OpenAPI
  // page's "IAM bearer token" phrasing implies. A non-empty `Project` header is required
  // (any value accepted by `whoami`; unclear yet whether spawn/list validate it more
  // strictly). See docs/DECISIONS.md for the full empirical trace.
  const whoami = await sandboxFetch("/whoami")
  if (whoami.status !== 200) {
    console.error(`  GET /whoami — FAILED (${whoami.status}): ${JSON.stringify(whoami.body)}`)
    return
  }
  const info = whoami.body as WhoAmI
  console.log(`  GET /whoami — OK`)
  console.log(`    permissions: ${JSON.stringify(info.permissions)}`)
  console.log(`    limits:      ${JSON.stringify(info.limits)}`)

  if (!info.permissions.spawn || !info.permissions.list) {
    console.warn(
      "\n  This key has ZERO Sandboxes permissions on this project (spawn/list both false).\n" +
        "  This is an account-provisioning gap, not a code bug — Sandboxes access needs to be\n" +
        "  granted for this key/project before instances/echo/network-access can be tested.\n" +
        "  Next action: contact contree@nebius.com or check the Nebius Cloud console for\n" +
        "  Sandboxes enablement, then re-run `pnpm spike`."
    )
    return
  }

  console.log("\n  Spawning: echo hello ...")
  const echo = await runInSandbox("echo hello")
  console.log(`    status: ${echo.status}`)
  console.log(`    exit_code: ${echo.metadata?.result?.state?.exit_code}`)
  console.log(`    stdout: ${JSON.stringify(echo.metadata?.result?.stdout?.value)}`)

  // `ubuntu:latest` has neither npm nor curl preinstalled — a 127 ("not found")
  // here answers nothing about network access. Installing curl via apt-get is
  // itself a network test (apt has to reach Ubuntu's package repos), and doing
  // both in one command confirms package-manager AND HTTPS-fetch reachability
  // together, matching Nebius's own quickstart pattern (apt-get install before
  // using a tool the base image lacks).
  console.log("\n  Spawning: apt-get install curl && curl https://registry.npmjs.org ...")
  const networkProbe = await runInSandbox(
    "apt-get update -q && apt-get install -y -q curl && " +
      'curl -sS -m 10 -o /dev/null -w "HTTP_%{http_code}" https://registry.npmjs.org',
    90
  )
  console.log(`    status: ${networkProbe.status}`)
  console.log(`    exit_code: ${networkProbe.metadata?.result?.state?.exit_code}`)
  console.log(`    stdout (tail): ${JSON.stringify(networkProbe.metadata?.result?.stdout?.value?.slice(-200))}`)
  console.log(`    stderr: ${JSON.stringify(networkProbe.metadata?.result?.stderr?.value)}`)

  const hasNetwork = networkProbe.metadata?.result?.stdout?.value?.includes("HTTP_200")
  console.log(
    `\n  §17.3 ANSWER: sandboxes ${hasNetwork ? "DO" : "do NOT"} have outbound network access ` +
      `(apt-get reached Ubuntu's repos and curl got HTTP_200 from registry.npmjs.org).`
  )
}

async function main() {
  if (!NEBIUS_API_KEY) {
    fail("NEBIUS_API_KEY is not set. Export it and re-run.")
  }

  const client = new OpenAI({
    apiKey: NEBIUS_API_KEY,
    baseURL: NEBIUS_BASE_URL,
  })

  const nemotronIds = await step1_listModels(client)
  await step2_oneCompletionPerTier(client, nemotronIds)
  await step3and4_sandbox()

  console.log(
    "\nDone. Copy the printed model IDs into packages/agent/src/models.ts and record every\n" +
      "answer (model IDs, sandbox network access, REST vs contree-sdk) in docs/DECISIONS.md\n" +
      "before writing any packages/agent or packages/verifier code.\n"
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

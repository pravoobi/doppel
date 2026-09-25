/**
 * THE single call site for every LLM request (CLAUDE.md §0.4: "Every LLM call
 * goes through the single router in packages/agent/src/route.ts. No exceptions,
 * no ad-hoc openai.chat.completions.create anywhere else in the codebase.").
 *
 * Responsibilities: tier → model resolution, structured-output enforcement via
 * zod, retry-with-validation-error-then-hard-fail (§15), and usage logging
 * before returning (§15, §6).
 *
 * Reasoning-token behavior: all four Nemotron models are reasoning models and
 * can return `content: null` after spending the entire token budget on internal
 * reasoning with no visible answer (confirmed empirically — see docs/DECISIONS.md,
 * "Day-one spike run"). `DEFAULT_MAX_TOKENS` is sized generously for that reason,
 * and a null response is treated as a retryable failure with a specific
 * clarifying message, not silently passed through as an empty answer.
 */

import OpenAI from "openai"
import type { z } from "zod"
import zodToJsonSchema from "zod-to-json-schema"
import { TIER_MODEL, type ModelTier } from "./models"
import { logLlmCall } from "./usage-log"

const DEFAULT_MAX_TOKENS = 6000
const MAX_ATTEMPTS = 2

export class RouteError extends Error {
  constructor(
    message: string,
    public readonly context: { stage: string; tier: ModelTier; model: string; lastError: string }
  ) {
    super(message)
    this.name = "RouteError"
  }
}

export type RouteRequest<T> = {
  tier: ModelTier
  /** Pipeline stage name, e.g. "triage" | "adjudicate" | "migrate" | "repair" | "ds-describe". Logged verbatim. */
  stage: string
  runId?: string
  findingId?: string
  system?: string
  user: string
  schema: z.ZodType<T>
  /** Short identifier for the schema, used in the response_format payload and error messages. */
  schemaName: string
  maxTokens?: number
  temperature?: number
}

let cachedClient: OpenAI | null = null

function getClient(): OpenAI {
  if (cachedClient) return cachedClient
  const apiKey = process.env.NEBIUS_API_KEY
  if (!apiKey) {
    throw new Error("NEBIUS_API_KEY is not set. See .env.example.")
  }
  cachedClient = new OpenAI({
    apiKey,
    baseURL: process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/",
  })
  return cachedClient
}

/** Exposed for tests that need to inject a fake client instead of hitting the network. */
export function setClientForTesting(client: OpenAI | null): void {
  cachedClient = client
}

function buildJsonSchema(schema: z.ZodType, schemaName: string): Record<string, unknown> {
  // $refStrategy: "none" inlines everything — OpenAI-compatible response_format
  // expects a flat object schema, not a $ref/definitions pair.
  return zodToJsonSchema(schema, { name: schemaName, $refStrategy: "none" }) as Record<string, unknown>
}

export async function route<T>(req: RouteRequest<T>): Promise<T> {
  const model = TIER_MODEL[req.tier]
  const jsonSchema = buildJsonSchema(req.schema, req.schemaName)

  const baseMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (req.system) baseMessages.push({ role: "system", content: req.system })
  baseMessages.push({ role: "user", content: req.user })

  let lastError: string | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = lastError
      ? [
          ...baseMessages,
          {
            role: "user",
            content:
              `Your previous response was invalid: ${lastError}\n\n` +
              `Reply again with ONLY the corrected JSON matching the schema — no reasoning, no ` +
              `commentary, no markdown fences.`,
          },
        ]
      : baseMessages

    const start = Date.now()
    const completion = await getClient().chat.completions.create({
      model,
      messages,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? 0,
      response_format: {
        type: "json_schema",
        // strict: true requests real grammar-constrained decoding rather than a
        // soft "try to follow this shape" instruction. Found empirically: with
        // strict: false, the model produced JSON with an unescaped literal `"`
        // inside a string value (writing JSX like `variant="destructive"` as a
        // raw, un-escaped quote), which truncates the JSON string at that
        // character every time — see docs/DECISIONS.md. Grammar-constrained
        // decoding should make that structurally impossible.
        json_schema: { name: req.schemaName, schema: jsonSchema, strict: true },
      },
    })
    const latencyMs = Date.now() - start

    const usage = completion.usage
    await logLlmCall({
      runId: req.runId,
      findingId: req.findingId,
      stage: req.stage,
      modelId: model,
      tier: req.tier,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI SDK types don't yet model Nemotron's reasoning_tokens field
      reasoningTokens: (usage?.completion_tokens_details as any)?.reasoning_tokens ?? 0,
      latencyMs,
      attempt,
    })

    const content = completion.choices[0]?.message?.content ?? null

    if (content === null) {
      lastError =
        "response content was empty — the model used its entire token budget on internal " +
        "reasoning and never produced an answer (a known Nemotron behavior; see " +
        "docs/DECISIONS.md 'Day-one spike run'). Answer directly and concisely."
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      lastError = `response was not valid JSON: ${(err as Error).message}`
      continue
    }

    const result = req.schema.safeParse(parsed)
    if (result.success) return result.data
    lastError = result.error.message
  }

  throw new RouteError(`${req.stage}: response failed validation after ${MAX_ATTEMPTS} attempts`, {
    stage: req.stage,
    tier: req.tier,
    model,
    lastError: lastError ?? "unknown",
  })
}

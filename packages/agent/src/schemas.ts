/**
 * Zod schemas for every structured LLM output (CLAUDE.md §15: "Every model response
 * is parsed through a zod schema. A parse failure is a retry with the validation
 * error appended, then a hard failure — never a silent fallback to free-form text.")
 */

import { z } from "zod"

/** §5.1 — one cheap Nano call per DS component. */
export const DsDescriptionSchema = z.object({
  description: z.string().min(1),
  aliases: z.array(z.string()),
})
export type DsDescription = z.infer<typeof DsDescriptionSchema>

/** §5.4 — Nano, batched. One object per candidate in the batch. */
export const TriageResultSchema = z.object({
  id: z.string(),
  match: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
})
export const TriageBatchSchema = z.array(TriageResultSchema)
export type TriageResult = z.infer<typeof TriageResultSchema>

/** §5.5 — Super. */
export const ClassificationSchema = z.enum(["DRIFT", "INTENTIONAL_DEVIATION", "NOT_DRIFT"])
export type Classification = z.infer<typeof ClassificationSchema>

export const RiskSchema = z.enum(["low", "medium", "high"])
export type Risk = z.infer<typeof RiskSchema>

export const PropMappingEntrySchema = z.object({
  from: z.string(),
  to: z.string(),
  note: z.string().optional(),
})

export const AdjudicationSchema = z.object({
  classification: ClassificationSchema,
  rationale: z.string().min(1),
  propMapping: z.array(PropMappingEntrySchema),
  unmappable: z.array(z.string()),
  risk: RiskSchema.nullable(),
})
export type Adjudication = z.infer<typeof AdjudicationSchema>

/**
 * §5.6 — Ultra. Also reused as the repair output shape (§5.7 step 6: "one Ultra
 * repair attempt with the error text, then re-verify") — a repair is structurally
 * the same deliverable as a migration, just produced from a different prompt.
 */
export const MigrationSchema = z.object({
  replacementJsx: z.string().min(1),
  importsToAdd: z.array(z.string()),
  notes: z.string(),
  confidence: z.number().min(0).max(1),
})
export type Migration = z.infer<typeof MigrationSchema>

/**
 * §5.7 step 1 — Ultra, cached per component. Generates a realistic props fixture
 * from a component's TS signature and its real call sites, so the render harness
 * (packages/verifier) can mount it without guessing prop values.
 */
export const PropsFixtureSchema = z.object({
  props: z.record(z.unknown()),
  notes: z.string(),
})
export type PropsFixture = z.infer<typeof PropsFixtureSchema>

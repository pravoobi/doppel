/**
 * Drizzle schema for the runs/findings/llm_calls datastore (CLAUDE.md §6).
 * Postgres (Neon free tier), per CLAUDE.md §4's datastore decision.
 */

import { relations } from "drizzle-orm"
import { index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type { Fingerprint } from "@doppel/shared"

export const runStatusEnum = pgEnum("run_status", ["pending", "running", "completed", "failed"])
export const classificationEnum = pgEnum("classification", ["DRIFT", "INTENTIONAL_DEVIATION", "NOT_DRIFT"])
export const riskEnum = pgEnum("risk", ["low", "medium", "high"])
// §2.1's five verdicts, plus a sixth "no verdict yet" state a row starts in
// (NOT_DRIFT/INTENTIONAL_DEVIATION findings never get a verify-stage verdict
// at all — see the findings table's own comment below).
export const verdictEnum = pgEnum("verdict", ["PASS", "REVIEW", "FAIL", "UNVERIFIABLE", "INTENTIONAL_DEVIATION"])
export const tierEnum = pgEnum("tier", ["nano", "super", "ultra"])

export type RunStats = {
  filesScanned: number
  candidates: number
  filtered: number
  triaged: number
  drifts: number
  // §9's drift-map treemap needs real LOC per scanned file. Computed once
  // during the scan pass (pipeline.ts) and persisted here rather than
  // re-reading the filesystem at render time, which wouldn't work in a real
  // deployment anyway — repoRoot itself is deliberately NOT a column on this
  // table (see pipeline.ts's own header). Keyed by path relative to repoRoot,
  // same convention as findings.file. Optional so old rows (persisted before
  // this field existed) don't need a migration.
  fileLoc?: Record<string, number>
}

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoUrl: text("repo_url").notNull(),
  ref: text("ref"),
  dsPath: text("ds_path"),
  status: runStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  stats: jsonb("stats").$type<RunStats>(),
})

/** §5.5's `propMapping` entries — mirrors @doppel/agent's PropMappingEntrySchema shape without depending on that package (db shouldn't need agent's runtime deps just for a type). */
export type PropMappingEntry = { from: string; to: string; note?: string }

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    file: text("file").notNull(),
    line: integer("line").notNull(),
    endLine: integer("end_line").notNull(),
    fingerprint: jsonb("fingerprint").$type<Fingerprint>().notNull(),
    matchedComponent: text("matched_component"),
    triageConfidence: real("triage_confidence"),
    // Null until adjudicate (M2) runs — a candidate that never reached
    // adjudication (e.g. dropped by triage) has a fingerprint but no verdict.
    classification: classificationEnum("classification"),
    rationale: text("rationale"),
    propMapping: jsonb("prop_mapping").$type<PropMappingEntry[]>(),
    unmappable: jsonb("unmappable").$type<string[]>(),
    risk: riskEnum("risk"),
    originalSource: text("original_source").notNull(),
    // Null for NOT_DRIFT/INTENTIONAL_DEVIATION findings — §5.6: migrate only
    // runs "for classification === 'DRIFT'", so there's never a patch to show.
    patchedSource: text("patched_source"),
    // Migration.importsToAdd (packages/agent) — needed to apply patchedSource
    // as a real, compiling file edit (PR export) rather than just displaying
    // it. Previously computed and discarded in-memory each run; persisting it
    // is what makes PR export possible without re-deriving imports by hand.
    importsToAdd: jsonb("imports_to_add").$type<string[]>(),
    // Null until the verify stage (M3) runs — and always null for
    // NOT_DRIFT/INTENTIONAL_DEVIATION, which never reach verify at all.
    verdict: verdictEnum("verdict"),
    deltaRatio: real("delta_ratio"),
    verifyLog: text("verify_log"),
    beforeUrl: text("before_url"),
    afterUrl: text("after_url"),
    diffUrl: text("diff_url"),
  },
  (table) => [
    index("findings_run_id_idx").on(table.runId),
    // §9: "Verdict filters across the top, with counts" — this is the query that backs them.
    index("findings_run_id_verdict_idx").on(table.runId, table.verdict),
  ]
)

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // Null for run-level calls not tied to one finding (e.g. §5.1's DS
    // description pass runs once per component, before any candidate exists).
    findingId: uuid("finding_id").references(() => findings.id, { onDelete: "set null" }),
    stage: text("stage").notNull(),
    modelId: text("model_id").notNull(),
    tier: tierEnum("tier").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    // Null when config/pricing.json has no entry for the model — never a guessed number (see that file's own $note).
    costUsd: real("cost_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // §7: the cost panel is "a GROUP BY over this table" — grouped by run, then stage/tier.
    index("llm_calls_run_id_idx").on(table.runId),
    index("llm_calls_run_id_stage_tier_idx").on(table.runId, table.stage, table.tier),
  ]
)

export const runsRelations = relations(runs, ({ many }) => ({
  findings: many(findings),
  llmCalls: many(llmCalls),
}))

export const findingsRelations = relations(findings, ({ one, many }) => ({
  run: one(runs, { fields: [findings.runId], references: [runs.id] }),
  llmCalls: many(llmCalls),
}))

export const llmCallsRelations = relations(llmCalls, ({ one }) => ({
  run: one(runs, { fields: [llmCalls.runId], references: [runs.id] }),
  finding: one(findings, { fields: [llmCalls.findingId], references: [findings.id] }),
}))

export type Run = typeof runs.$inferSelect
export type NewRun = typeof runs.$inferInsert
export type Finding = typeof findings.$inferSelect
export type NewFinding = typeof findings.$inferInsert
export type LlmCall = typeof llmCalls.$inferSelect
export type NewLlmCall = typeof llmCalls.$inferInsert

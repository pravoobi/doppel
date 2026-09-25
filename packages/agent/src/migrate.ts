/**
 * §5.6 — Nemotron Ultra. Only for classification === 'DRIFT'.
 *
 * This is the one stage deliberately called once per candidate on the Ultra tier
 * (CLAUDE.md §7's cost table has ~25 migrate calls on the fixture, one per drift
 * finding) — it is not the "Ultra inside a loop" anti-pattern §15 warns against.
 * That warning is about accidentally reaching for Ultra where a cheap batched call
 * (like triage) would do; migration is inherently a per-candidate creative-writing
 * task that doesn't batch the way classification does.
 */

import type { DsComponent } from "@doppel/shared"
import type { z } from "zod"
import { loadPrompt } from "./prompts"
import { route } from "./route"
import { MigrationSchema, PropMappingEntrySchema, type Migration } from "./schemas"

export type MigrateInput = {
  candidateId: string
  candidateSource: string
  matchedComponent: DsComponent
  existingImports: string[]
  propMapping: z.infer<typeof PropMappingEntrySchema>[]
}

export async function migrateCandidate(
  input: MigrateInput,
  opts: { runId?: string } = {}
): Promise<Migration> {
  const user = loadPrompt("migrate", {
    candidateSource: input.candidateSource,
    componentName: input.matchedComponent.name,
    componentProps: JSON.stringify(input.matchedComponent.props, null, 2),
    componentVariants: JSON.stringify(input.matchedComponent.variants, null, 2),
    componentSourceExcerpt: input.matchedComponent.sourceExcerpt,
    existingImports: input.existingImports.join("\n"),
    propMapping: JSON.stringify(input.propMapping, null, 2),
  })

  return route({
    tier: "ultra",
    stage: "migrate",
    runId: opts.runId,
    // See adjudicate.ts: candidateId is not a findings-table UUID.
    user,
    schema: MigrationSchema,
    schemaName: "Migration",
    // A small non-zero temperature mitigates a degenerate-repetition failure mode
    // observed at temperature 0: the model occasionally loops (thousands of lines
    // of whitespace/near-duplicate tokens) until max_tokens cuts it off mid-JSON.
    // See docs/DECISIONS.md.
    temperature: 0.2,
    // NOT a fix for the truncation failures below — tested at 16000 and the
    // failure position scaled up proportionally (~15500 chars instead of
    // ~5500), proving that specific failure is a genuine runaway-repetition
    // loop, not a budget shortfall; raising the ceiling just let it run longer
    // before failing, at higher cost. Kept modestly above the router default
    // as cheap insurance for legitimately long migrations, not as the fix for
    // the recurring "L4" pre-splice failures — see docs/DECISIONS.md.
    maxTokens: 8000,
  })
}

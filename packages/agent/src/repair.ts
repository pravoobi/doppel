/**
 * §5.7 step 6 — Ultra, given a compiler error. Exactly one repair attempt per
 * finding; the verifier (M3) never loops this more than once.
 */

import type { DsComponent } from "@doppel/shared"
import { loadPrompt } from "./prompts"
import { route } from "./route"
import { MigrationSchema, type Migration } from "./schemas"

export type RepairInput = {
  candidateId: string
  candidateSource: string
  matchedComponent: DsComponent
  previousReplacementJsx: string
  compilerError: string
}

export async function repairMigration(
  input: RepairInput,
  opts: { runId?: string } = {}
): Promise<Migration> {
  const user = loadPrompt("repair", {
    candidateSource: input.candidateSource,
    componentName: input.matchedComponent.name,
    componentProps: JSON.stringify(input.matchedComponent.props, null, 2),
    componentVariants: JSON.stringify(input.matchedComponent.variants, null, 2),
    previousReplacementJsx: input.previousReplacementJsx,
    compilerError: input.compilerError,
  })

  return route({
    tier: "ultra",
    stage: "repair",
    runId: opts.runId,
    // See adjudicate.ts: candidateId is not a findings-table UUID.
    user,
    schema: MigrationSchema,
    schemaName: "Migration",
    temperature: 0.2, // see migrate.ts — mitigates a degenerate-repetition failure mode at temp 0
    maxTokens: 8000, // see migrate.ts — modest headroom; NOT a fix for the repeated "L4" failures
  })
}

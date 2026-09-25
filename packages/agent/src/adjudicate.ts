/** §5.5 — Nemotron Super. Full source in, classification + prop mapping out. */

import type { DsComponent } from "@doppel/shared"
import { loadPrompt } from "./prompts"
import { route } from "./route"
import { AdjudicationSchema, type Adjudication } from "./schemas"

export type AdjudicateInput = {
  candidateId: string
  /** The candidate's own JSX source. */
  candidateSource: string
  /** The containing component or file, for context. */
  surroundingSource: string
  matchedComponent: DsComponent
}

export async function adjudicateCandidate(
  input: AdjudicateInput,
  opts: { runId?: string } = {}
): Promise<Adjudication> {
  const user = loadPrompt("adjudicate", {
    candidateSource: input.candidateSource,
    surroundingSource: input.surroundingSource,
    componentName: input.matchedComponent.name,
    componentProps: JSON.stringify(input.matchedComponent.props, null, 2),
    componentVariants: JSON.stringify(input.matchedComponent.variants, null, 2),
    componentSourceExcerpt: input.matchedComponent.sourceExcerpt,
  })

  return route({
    tier: "super",
    stage: "adjudicate",
    runId: opts.runId,
    // NOT input.candidateId: that's a scanner-internal id (e.g. "c6"), not a
    // findings-table UUID — no finding row exists yet at this point in the
    // pipeline (the orchestrator inserts it only after adjudicate/migrate
    // succeed). Passing it here broke DrizzleUsageSink's uuid column; the
    // JsonlUsageSink used by scripts/m2-pipeline.ts never caught it since it
    // accepts any string.
    user,
    schema: AdjudicationSchema,
    schemaName: "Adjudication",
  })
}

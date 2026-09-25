/** §5.1 — one cheap Nano call per DS component, filling in `description`/`aliases`. */

import type { DsComponent } from "@doppel/shared"
import { loadPrompt } from "./prompts"
import { route } from "./route"
import { DsDescriptionSchema, type DsDescription } from "./schemas"

export async function describeDsComponent(
  component: DsComponent,
  opts: { runId?: string } = {}
): Promise<DsDescription> {
  const user = loadPrompt("ds-describe", {
    componentName: component.name,
    componentProps: JSON.stringify(component.props, null, 2),
    componentVariants: JSON.stringify(component.variants, null, 2),
    componentSourceExcerpt: component.sourceExcerpt,
  })

  return route({
    tier: "nano",
    stage: "ds-describe",
    runId: opts.runId,
    user,
    schema: DsDescriptionSchema,
    schemaName: "DsDescription",
    maxTokens: 1000,
  })
}

/**
 * §5.7 step 1 sub-bullet — Ultra, cached per component (not per candidate/call —
 * "this is the single most repeated Ultra call and caching it is worth real
 * money"). Caching itself isn't implemented here; that's an orchestrator concern
 * (M4) once there's a persistence layer to cache against. This is the call
 * `packages/verifier`'s harness consumes the output of — see harness.ts's
 * `HarnessInput.props`.
 */

import { loadPrompt } from "./prompts"
import { route } from "./route"
import { PropsFixtureSchema, type PropsFixture } from "./schemas"

export type PropsSynthesisInput = {
  componentName: string
  /** The component's own prop type/interface source, as text. */
  propsTypeSource: string
  /** Real JSX usages of this component elsewhere in the codebase, for realistic values. */
  callSiteSamples: string[]
}

export async function synthesizeProps(
  input: PropsSynthesisInput,
  opts: { runId?: string } = {}
): Promise<PropsFixture> {
  const user = loadPrompt("synthesize-props", {
    componentName: input.componentName,
    propsTypeSource: input.propsTypeSource,
    callSiteSamples:
      input.callSiteSamples.length > 0 ? input.callSiteSamples.join("\n\n") : "(no real usage found elsewhere in the codebase)",
  })

  return route({
    tier: "ultra",
    stage: "props-synthesis",
    runId: opts.runId,
    user,
    schema: PropsFixtureSchema,
    schemaName: "PropsFixture",
  })
}

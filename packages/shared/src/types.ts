/**
 * Shared types for the deterministic scanner pipeline (CLAUDE.md §5.1-§5.3).
 * No network, no model dependency — pure data shapes.
 */

export type PropSpec = {
  name: string
  type: string
  optional: boolean
  /** Union literal members, when the type is a string-literal union (e.g. variant props). */
  literals?: string[]
}

export type DsComponent = {
  name: string
  importPath: string
  props: PropSpec[]
  /** e.g. { variant: ["default","destructive"], size: ["default","sm","lg","icon"] } */
  variants: Record<string, string[]>
  /** First ~80 lines of source, for the adjudicator's context (M2). */
  sourceExcerpt: string
  /** Nano-authored one-line description. Empty until the Nano DS-description pass runs (M2). */
  description: string
  /** Nano-authored aliases, e.g. ["banner","callout","notice"]. Empty until M2. */
  aliases: string[]
}

export type DsIndex = {
  path: string
  components: DsComponent[]
}

export type Fingerprint = {
  rootTag: string
  depth: number
  childTags: string[]
  /** Normalised utility class tokens: bg-*, rounded-*, px-*, text-*, etc. */
  classTokens: string[]
  ariaRole: string | null
  hasHandler: boolean
  /** First 40 chars of literal text content, for context. */
  textSample: string
  file: string
  line: number
}

export type Candidate = {
  id: string
  file: string
  line: number
  endLine: number
  fingerprint: Fingerprint
  /** The candidate's own JSX source text (§5.5/§5.6: adjudicate/migrate need full source). */
  sourceText: string
}

export type ShortlistedCandidate = Candidate & {
  /** 1-3 plausible DS component names, ranked by rule specificity. Never empty. */
  shortlist: string[]
}

/**
 * §2.1 — the five verdicts. INTENTIONAL_DEVIATION is an adjudicate-stage (M2)
 * outcome, not something the verifier itself produces; it's included here so a
 * single `Verdict` type can describe a finding's end state regardless of which
 * stage set it.
 */
export type Verdict = "PASS" | "REVIEW" | "FAIL" | "UNVERIFIABLE" | "INTENTIONAL_DEVIATION"

/** Per-viewport pixel-diff result (§5.7 step 3). */
export type ViewportDiffResult = {
  viewport: number
  deltaRatio: number
  diffPngPath?: string
}

/** §5.7 steps 3-5: everything the verdict decision is based on, worst-case across viewports. */
export type VerificationInput = {
  /** false when the harness couldn't mount the component at all — short-circuits to UNVERIFIABLE. */
  renderable: boolean
  viewportResults: ViewportDiffResult[]
  typecheckPassed: boolean
  lintPassed: boolean
  /** Compiler/lint error text, when either check failed — carried through for the repair prompt. */
  errorText?: string
}

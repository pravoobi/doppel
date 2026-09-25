/**
 * Verdict decision (CLAUDE.md §2.1). Pure function, no I/O — given the results of
 * rendering/diffing/typechecking/linting a patch, decide PASS / REVIEW / FAIL /
 * UNVERIFIABLE. (INTENTIONAL_DEVIATION is decided earlier, at adjudicate — see
 * @doppel/shared's Verdict type.)
 *
 * Thresholds come from CLAUDE.md §16's env vars, with the same defaults:
 *   DOPPEL_PIXEL_PASS_THRESHOLD=0.005    (≤0.5% delta at every viewport → PASS)
 *   DOPPEL_PIXEL_REVIEW_THRESHOLD=0.05   (≤5% delta → REVIEW, above → FAIL)
 */

import type { VerificationInput, Verdict } from "@doppel/shared"

export type Thresholds = {
  passMaxDeltaRatio: number
  reviewMaxDeltaRatio: number
}

export function loadThresholdsFromEnv(): Thresholds {
  return {
    passMaxDeltaRatio: Number(process.env.DOPPEL_PIXEL_PASS_THRESHOLD ?? 0.005),
    reviewMaxDeltaRatio: Number(process.env.DOPPEL_PIXEL_REVIEW_THRESHOLD ?? 0.05),
  }
}

export function computeVerdict(
  input: VerificationInput,
  thresholds: Thresholds = loadThresholdsFromEnv()
): Verdict {
  if (!input.renderable) return "UNVERIFIABLE"
  if (!input.typecheckPassed || !input.lintPassed) return "FAIL"
  if (input.viewportResults.length === 0) return "UNVERIFIABLE"

  // "using the worst result across viewports" — §5.7 step 5.
  const worstDeltaRatio = Math.max(...input.viewportResults.map((v) => v.deltaRatio))

  if (worstDeltaRatio <= thresholds.passMaxDeltaRatio) return "PASS"
  if (worstDeltaRatio <= thresholds.reviewMaxDeltaRatio) return "REVIEW"
  return "FAIL"
}

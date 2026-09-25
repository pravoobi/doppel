/**
 * Rule-based candidate → DS component shortlist (CLAUDE.md §5.3). Deterministic,
 * zero LLM calls — this is the credit-efficiency lever that cuts inference
 * volume an order of magnitude before anything reaches Nano.
 */

import type { Fingerprint } from "@doppel/shared"

const DIV_LIKE = new Set(["div", "section", "article"])
const PILL_LIKE = new Set(["span", "div", "a"])
const ALERT_COLORS = /^(bg|border)-(red|amber|yellow|orange|rose|green|emerald)-/

function has(tokens: string[], re: RegExp): boolean {
  return tokens.some((t) => re.test(t))
}

function hasToken(tokens: string[], token: string): boolean {
  return tokens.includes(token)
}

/**
 * A dialog/overlay root owns its internal structure — its backdrop and content
 * wrapper are implementation details of the modal, not separate drift candidates.
 * Extraction uses this same predicate to stop recursing once it fires.
 */
export function isDialogOverlay(fp: Pick<Fingerprint, "rootTag" | "classTokens">): boolean {
  return (
    fp.rootTag === "div" &&
    hasToken(fp.classTokens, "fixed") &&
    hasToken(fp.classTokens, "inset-0") &&
    has(fp.classTokens, /^z-/)
  )
}

function isCardShaped(fp: Fingerprint): boolean {
  return (
    DIV_LIKE.has(fp.rootTag) &&
    has(fp.classTokens, /^rounded(-|$)/) &&
    has(fp.classTokens, /^border(-|$)/) &&
    has(fp.classTokens, /^p[xy]?-/)
  )
}

function isButtonShapedLink(fp: Fingerprint): boolean {
  // An <a> laid out and padded like a button (a pill CTA, say) is structurally a
  // Button even with no click handler — the fixture's trap-001 is exactly this:
  // a brand CTA link that LOOKS like Button but is deliberately off-system.
  return (
    fp.rootTag === "a" &&
    hasToken(fp.classTokens, "inline-flex") &&
    has(fp.classTokens, /^rounded/) &&
    has(fp.classTokens, /^px-/)
  )
}

function isButtonShaped(fp: Fingerprint): boolean {
  return (
    fp.rootTag === "button" ||
    fp.ariaRole === "button" ||
    (fp.hasHandler && hasToken(fp.classTokens, "cursor-pointer")) ||
    isButtonShapedLink(fp)
  )
}

function isAlertShaped(fp: Fingerprint): boolean {
  return (
    (fp.rootTag === "div" && has(fp.classTokens, ALERT_COLORS)) || fp.ariaRole === "alert"
  )
}

function isBadgeShaped(fp: Fingerprint): boolean {
  return (
    PILL_LIKE.has(fp.rootTag) &&
    has(fp.classTokens, /^rounded-full/) &&
    has(fp.classTokens, /^text-xs/) &&
    has(fp.classTokens, /^px-/)
  )
}

function isInputWrapperShaped(fp: Fingerprint): boolean {
  return fp.rootTag === "div" && fp.childTags.includes("label") && fp.childTags.includes("input")
}

function isDialogShaped(fp: Fingerprint): boolean {
  return isDialogOverlay(fp)
}

function isTableShaped(fp: Fingerprint): boolean {
  return fp.rootTag === "table"
}

const RULES: Array<{ component: string; test: (fp: Fingerprint) => boolean }> = [
  { component: "Button", test: isButtonShaped },
  { component: "Alert", test: isAlertShaped },
  { component: "Badge", test: isBadgeShaped },
  { component: "Input", test: isInputWrapperShaped },
  { component: "Dialog", test: isDialogShaped },
  { component: "Table", test: isTableShaped },
  // Card last: broadest structural match, so it never masks a more specific rule.
  { component: "Card", test: isCardShaped },
]

/** Maps a fingerprint to 1-3 plausible DS component names. Empty when no rule fires. */
export function shortlistFingerprint(fp: Fingerprint, knownComponents?: string[]): string[] {
  const matches = RULES.filter((r) => r.test(fp)).map((r) => r.component)
  const filtered = knownComponents
    ? matches.filter((m) => knownComponents.includes(m))
    : matches
  return filtered.slice(0, 3)
}

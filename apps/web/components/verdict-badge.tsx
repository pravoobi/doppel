import { Badge } from "@/components/ui/badge"
import type { Finding } from "@doppel/db"

/** CLAUDE.md §2.1's exact verdict → color mapping. */
const VERDICT_STYLES: Record<string, string> = {
  PASS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  REVIEW: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  FAIL: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  UNVERIFIABLE: "bg-muted text-muted-foreground",
  INTENTIONAL_DEVIATION: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  DRIFT: "Drift",
  INTENTIONAL_DEVIATION: "Intentional deviation",
  NOT_DRIFT: "Not drift",
}

/**
 * A finding's displayed state: its verdict once verified, or — when verify
 * didn't run (NEBIUS_API_KEY/NEBIUS_PROJECT_ID unset, or the candidate's JSX
 * couldn't be isolated at all, see lib/pipeline.ts) — its classification,
 * with an honest "pending verification" label rather than pretending a
 * verdict exists.
 */
export function VerdictBadge({ finding }: { finding: Pick<Finding, "verdict" | "classification"> }) {
  if (finding.verdict) {
    return <Badge className={VERDICT_STYLES[finding.verdict]}>{finding.verdict}</Badge>
  }
  if (finding.classification === "DRIFT") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        verification pending
      </Badge>
    )
  }
  if (finding.classification) {
    const style = VERDICT_STYLES[finding.classification] // defined for INTENTIONAL_DEVIATION; NOT_DRIFT falls through to the default badge style
    return <Badge className={style}>{CLASSIFICATION_LABELS[finding.classification]}</Badge>
  }
  return <Badge variant="outline">unclassified</Badge>
}

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { VerdictBadge } from "@/components/verdict-badge"
import type { Finding } from "@doppel/db"

const RISK_STYLES: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-amber-700 dark:text-amber-400",
  high: "text-red-700 dark:text-red-400",
}

function SourceBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function FindingCard({ finding }: { finding: Finding }) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">
            {finding.file}:{finding.line}
          </span>
          {finding.matchedComponent && <Badge variant="secondary">{finding.matchedComponent}</Badge>}
          {finding.triageConfidence != null && (
            <span className="text-xs text-muted-foreground">
              {Math.round(finding.triageConfidence * 100)}% confidence
            </span>
          )}
          {finding.risk && (
            <span className={`text-xs font-medium ${RISK_STYLES[finding.risk]}`}>{finding.risk} risk</span>
          )}
        </div>
        <VerdictBadge finding={finding} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {finding.rationale && <p className="text-sm text-muted-foreground">{finding.rationale}</p>}

        <div className="flex flex-col gap-3 sm:flex-row">
          <SourceBlock label="Original" code={finding.originalSource} />
          {finding.patchedSource && <SourceBlock label="Patched" code={finding.patchedSource} />}
        </div>

        {/* beforeUrl/afterUrl/diffUrl are data: URLs (base64 PNGs embedded
            directly, see lib/pipeline.ts's verifyResultToFindingFields) — no
            blob storage stood up for this yet, and a plain <img> handles a
            data: URL directly; next/image doesn't apply here (it optimizes
            remote/static assets, not inline data URLs). */}
        {finding.beforeUrl && finding.afterUrl && finding.diffUrl && (
          <div className="grid grid-cols-3 gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={finding.beforeUrl} alt="Before" className="rounded-md border" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={finding.afterUrl} alt="After" className="rounded-md border" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={finding.diffUrl} alt="Diff" className="rounded-md border" />
          </div>
        )}

        {finding.unmappable && finding.unmappable.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <p className="mb-1 font-medium">Can&apos;t be mapped cleanly:</p>
            <ul className="list-inside list-disc">
              {finding.unmappable.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

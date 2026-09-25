/**
 * PR body generation (CLAUDE.md §9: "a PR whose body embeds the before/after
 * images and the verdict table"). Pure string building — no I/O.
 *
 * GitHub PR bodies have a real 65536-character limit. A single before/after/
 * diff screenshot set as inline `data:` URLs (this project's dashboard
 * storage — see apps/web/lib/pipeline.ts) already blows that budget on ONE
 * finding, let alone several. So screenshots referenced here are NOT the
 * dashboard's data: URLs — the caller (export.ts) commits them as real files
 * on the same branch and passes their raw.githubusercontent.com URLs, which
 * cost only a few dozen characters each in the body.
 */

export type PrBodyFinding = {
  file: string
  line: number
  matchedComponent: string | null
  verdict: string | null
  deltaRatio: number | null
  beforeImageUrl: string | null
  afterImageUrl: string | null
  diffImageUrl: string | null
}

export function buildPrBody(findings: PrBodyFinding[], runId: string): string {
  const byComponent = new Map<string, PrBodyFinding[]>()
  for (const f of findings) {
    const key = f.matchedComponent ?? "(unmatched)"
    if (!byComponent.has(key)) byComponent.set(key, [])
    byComponent.get(key)!.push(f)
  }

  const lines: string[] = [
    `Design-system drift migrations verified by [Doppel](https://github.com) — run \`${runId}\`.`,
    "",
    "Every patch below rendered identically (or near-identically) to the original before being included here — see CLAUDE.md §2.1. Only `PASS` findings are exported.",
    "",
    "| Component | File | Verdict | Max Δ |",
    "|---|---|---|---|",
  ]

  for (const f of findings) {
    const delta = f.deltaRatio != null ? `${(f.deltaRatio * 100).toFixed(2)}%` : "—"
    lines.push(`| ${f.matchedComponent ?? "—"} | \`${f.file}:${f.line}\` | ${f.verdict ?? "—"} | ${delta} |`)
  }

  lines.push("", "---", "")

  for (const [component, group] of [...byComponent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### ${component}`, "")
    for (const f of group) {
      lines.push(`**\`${f.file}:${f.line}\`** — ${f.verdict}`, "")
      if (f.beforeImageUrl && f.afterImageUrl && f.diffImageUrl) {
        lines.push(
          `<img src="${f.beforeImageUrl}" width="260" alt="before"> <img src="${f.afterImageUrl}" width="260" alt="after"> <img src="${f.diffImageUrl}" width="260" alt="diff">`,
          ""
        )
      }
    }
  }

  return lines.join("\n")
}

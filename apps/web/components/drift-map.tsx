import Link from "next/link"
import { buildFileCells, densityColorClass } from "@/lib/drift-map"
import type { Finding } from "@doppel/db"

export function DriftMap({
  runId,
  fileLoc,
  findings,
}: {
  runId: string
  fileLoc: Record<string, number>
  findings: Finding[]
}) {
  const cells = buildFileCells(fileLoc, findings)
  if (cells.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Drift map</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Legend swatch="bg-muted" label="no findings" />
          <Legend swatch="bg-emerald-100 dark:bg-emerald-950" label="0% drift" />
          <Legend swatch="bg-amber-100 dark:bg-amber-950" label="low" />
          <Legend swatch="bg-orange-200 dark:bg-orange-900" label="mixed" />
          <Legend swatch="bg-red-300 dark:bg-red-900" label="mostly drift" />
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-1 rounded-lg border p-3">
        {cells.map((cell) => (
          <Link
            key={cell.file}
            href={`/runs/${runId}?filter=all&file=${encodeURIComponent(cell.file)}`}
            title={`${cell.file} — ${cell.loc} LOC, ${cell.driftCount}/${cell.totalFindings} drift findings`}
            style={{ width: cell.side, height: cell.side }}
            className={`flex items-end overflow-hidden rounded border p-1 text-[9px] leading-tight text-foreground/70 transition-transform hover:z-10 hover:scale-105 hover:shadow-md ${densityColorClass(cell.density, cell.totalFindings)}`}
          >
            <span className="truncate">{cell.file.split("/").pop()}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block size-2.5 rounded-sm border ${swatch}`} />
      {label}
    </span>
  )
}

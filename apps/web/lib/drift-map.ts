/**
 * Data prep for CLAUDE.md §9's drift map ("files as a treemap sized by LOC,
 * coloured by drift density"). LOC comes from `run.stats.fileLoc`, computed
 * once at scan time (see pipeline.ts) since repoRoot isn't persisted on the
 * run and re-reading the filesystem at render time wouldn't work in a real
 * deployment anyway.
 *
 * Layout is a simplified area-proportional grid (each cell's side length ∝
 * √LOC, wrapped in a flex grid) rather than a full squarified treemap
 * (Bruls/Huizing/van Wijk) — visually close for the file counts a demo repo
 * actually has, and far simpler to get correct. Named "drift map" per the
 * spec's own vocabulary; not claiming to be a rigorous treemap algorithm.
 */

import type { Finding } from "@doppel/db"

export type FileCell = {
  file: string
  loc: number
  driftCount: number
  totalFindings: number
  /** 0 when the file has no findings at all (neutral/no-data color). */
  density: number
  side: number
}

const MIN_SIDE = 28
const MAX_SIDE = 140

export function buildFileCells(fileLoc: Record<string, number>, findings: Finding[]): FileCell[] {
  const byFile = new Map<string, Finding[]>()
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file)!.push(f)
  }

  const entries = Object.entries(fileLoc).filter(([, loc]) => loc > 0)
  if (entries.length === 0) return []

  const maxLoc = Math.max(...entries.map(([, loc]) => loc))

  return entries
    .map(([file, loc]) => {
      const fileFindings = byFile.get(file) ?? []
      const driftCount = fileFindings.filter((f) => f.classification === "DRIFT").length
      const totalFindings = fileFindings.length
      const density = totalFindings > 0 ? driftCount / totalFindings : 0
      // Area (side²) proportional to LOC, clamped so a huge file doesn't
      // blow out the layout and a tiny one stays clickable.
      const side = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(MIN_SIDE + (MAX_SIDE - MIN_SIDE) * Math.sqrt(loc / maxLoc))))
      return { file, loc, driftCount, totalFindings, density, side }
    })
    .sort((a, b) => b.loc - a.loc)
}

/** Tailwind-safe fixed color stops — no dynamic class names (those get purged). */
export function densityColorClass(density: number, totalFindings: number): string {
  if (totalFindings === 0) return "bg-muted"
  if (density === 0) return "bg-emerald-100 dark:bg-emerald-950"
  if (density < 0.34) return "bg-amber-100 dark:bg-amber-950"
  if (density < 0.67) return "bg-orange-200 dark:bg-orange-900"
  return "bg-red-300 dark:bg-red-900"
}

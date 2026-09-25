/**
 * Turns finding.originalSource/patchedSource + line/endLine into a real file
 * edit — pure string manipulation, no I/O. `findings.line`/`endLine` come
 * from ts-morph (packages/scanner) as 1-indexed, inclusive line numbers
 * matching the ORIGINAL file content; PR export's caller is responsible for
 * fetching that same original content before calling this.
 */

export type PatchInput = {
  line: number
  endLine: number
  patchedSource: string
}

/**
 * Applies multiple patches to one file's content. Patches are applied
 * bottom-to-top (highest line number first) so splicing an earlier patch
 * never shifts the line numbers a later patch still expects to see.
 * Overlapping ranges throw — that would mean two findings claim the same
 * source lines, which should never happen for candidates extracted from
 * non-overlapping JSX subtrees, so silently picking one would hide a real
 * upstream bug.
 */
export function applyPatchesToFile(content: string, patches: PatchInput[]): string {
  const sorted = [...patches].sort((a, b) => b.line - a.line)

  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].endLine >= sorted[i + 1].line && sorted[i].line <= sorted[i + 1].endLine) {
      throw new Error(
        `applyPatchesToFile: overlapping patches at lines ${sorted[i].line}-${sorted[i].endLine} and ${sorted[i + 1].line}-${sorted[i + 1].endLine}`
      )
    }
  }

  const lines = content.split("\n")
  for (const patch of sorted) {
    const startIdx = patch.line - 1
    const endIdx = patch.endLine - 1
    if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
      throw new Error(`applyPatchesToFile: patch range ${patch.line}-${patch.endLine} is out of bounds for a ${lines.length}-line file`)
    }
    // Preserve the original line's leading indentation — patchedSource is a
    // bare JSX expression with no knowledge of its destination indent.
    const indent = lines[startIdx].match(/^\s*/)?.[0] ?? ""
    const replacementLines = patch.patchedSource.split("\n").map((l, i) => (i === 0 ? indent + l : l))
    lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines)
  }
  return lines.join("\n")
}

/**
 * Inserts any `importsToAdd` entries not already present (compared by their
 * exact text — good enough here since packages/agent's migrate.ts emits
 * fully-formed import statements, not fragments to merge) after the file's
 * existing top-of-file import block, or at the very top if it has none.
 */
export function mergeImports(content: string, importsToAdd: string[]): string {
  const missing = importsToAdd.filter((imp) => !content.includes(imp))
  if (missing.length === 0) return content

  const lines = content.split("\n")
  let insertAt = 0
  while (insertAt < lines.length && /^\s*(import\s|"use client"|'use client')/.test(lines[insertAt])) {
    insertAt++
  }
  lines.splice(insertAt, 0, ...missing)
  return lines.join("\n")
}

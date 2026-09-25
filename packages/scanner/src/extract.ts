/**
 * Walk an app's JSX and extract drift candidates (CLAUDE.md §5.2). Deterministic,
 * zero LLM calls.
 *
 * A candidate is a JSX subtree rooted at a host element (lowercase tag) that
 * satisfies at least one signal: a className with >=3 utility tokens, an inline
 * style, an interaction handler, a role/aria-* attribute, or a subtree of >=2
 * element nodes.
 *
 * One targeted exception: a `fixed inset-0 z-*` dialog/overlay root is extracted
 * as a single atomic candidate and its children are not walked for further
 * candidates. A modal's backdrop div and content wrapper are implementation
 * details of the modal, not separate drift candidates — see shortlist.ts
 * `isDialogOverlay` for the same predicate used here.
 */

import path from "node:path"
import { Node, type Project, type SourceFile } from "ts-morph"
import type { Candidate, Fingerprint, ShortlistedCandidate } from "@doppel/shared"
import {
  computeFingerprint,
  getClassTokens,
  getDescendantElements,
  getRole,
  hasAriaAttr,
  hasHandlerAttr,
  hasInlineStyle,
  getTagName,
} from "./fingerprint"
import { isDialogOverlay, shortlistFingerprint } from "./shortlist"

const EXCLUDE_FILE_RE = /\.(test|stories)\.tsx?$/

export type ExtractOptions = {
  dsDirAbsPath: string
  /** Extra absolute directory paths to exclude beyond the DS dir and node_modules. */
  excludeDirs?: string[]
}

function isExcluded(filePath: string, opts: ExtractOptions): boolean {
  if (EXCLUDE_FILE_RE.test(filePath)) return true
  if (/[\\/]node_modules[\\/]/.test(filePath)) return true
  const dirs = [opts.dsDirAbsPath, ...(opts.excludeDirs ?? [])]
  return dirs.some((d) => !path.relative(d, filePath).startsWith(".."))
}

function qualifiesAsRawCandidate(node: Node): boolean {
  const classTokens = getClassTokens(node)
  if (classTokens.length >= 3) return true
  if (hasInlineStyle(node)) return true
  if (hasHandlerAttr(node)) return true
  if (getRole(node) !== null || hasAriaAttr(node)) return true
  if (getDescendantElements(node).length >= 2) return true
  return false
}

let candidateCounter = 0

export function extractCandidates(project: Project, opts: ExtractOptions): Candidate[] {
  const candidates: Candidate[] = []

  for (const sf of project.getSourceFiles()) {
    if (isExcluded(sf.getFilePath(), opts)) continue
    walkFile(sf, opts, candidates)
  }

  return candidates
}

function walkFile(sf: SourceFile, opts: ExtractOptions, out: Candidate[]) {
  function visit(node: Node) {
    for (const child of node.getChildren()) {
      if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)) {
        const tag = getTagName(child)
        const isHostElement = /^[a-z]/.test(tag)

        if (isHostElement && qualifiesAsRawCandidate(child)) {
          const startLine = child.getStartLineNumber()
          const fp = computeFingerprint(child, sf.getFilePath(), startLine)
          out.push({
            id: `c${++candidateCounter}`,
            file: sf.getFilePath(),
            line: startLine,
            endLine: child.getEndLineNumber(),
            fingerprint: fp,
            sourceText: child.getText(),
          })

          if (isDialogOverlay(fp)) {
            // Atomic: don't walk this subtree for further candidates.
            continue
          }
        }
      }
      visit(child)
    }
  }

  visit(sf)
}

export function shortlistCandidates(
  candidates: Candidate[],
  knownComponents?: string[]
): ShortlistedCandidate[] {
  return candidates
    .map((c) => ({ ...c, shortlist: shortlistFingerprint(c.fingerprint, knownComponents) }))
    .filter((c) => c.shortlist.length > 0)
}

export function resetCandidateCounter() {
  candidateCounter = 0
}

export type { Fingerprint }

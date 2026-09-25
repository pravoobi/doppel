/**
 * Orchestrates CLAUDE.md §9's "Open PR": create a branch, apply PASS
 * findings' patches as real file edits (grouped and committed per DS
 * component — one commit per component, not one per finding, so the branch's
 * history reads like a real migration PR instead of noise), commit their
 * screenshots alongside so the PR body can link real URLs instead of
 * exceeding GitHub's PR body size limit (see pr-body.ts), and open the PR.
 */

import { applyPatchesToFile, mergeImports } from "./apply-patch"
import { buildPrBody, type PrBodyFinding } from "./pr-body"
import { GitHubClient, type RepoRef } from "./client"

export type ExportFinding = {
  id: string
  file: string
  line: number
  endLine: number
  patchedSource: string
  importsToAdd: string[] | null
  matchedComponent: string | null
  verdict: string | null
  deltaRatio: number | null
  beforeUrl: string | null
  afterUrl: string | null
  diffUrl: string | null
}

export type ExportPrInput = {
  repo: RepoRef
  baseBranch: string
  runId: string
  findings: ExportFinding[]
}

export type ExportPrResult = {
  branch: string
  prNumber: number
  prUrl: string
}

const SCREENSHOT_DIR = ".doppel/screenshots"

function dataUrlToBase64(dataUrl: string | null): string | null {
  if (!dataUrl) return null
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/)
  return match ? match[1] : null
}

function rawUrl(repo: RepoRef, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${encodeURIComponent(path).replace(/%2F/g, "/")}`
}

export async function exportPassFindingsAsPr(client: GitHubClient, input: ExportPrInput): Promise<ExportPrResult> {
  const passFindings = input.findings.filter((f) => f.verdict === "PASS")
  if (passFindings.length === 0) {
    throw new Error("exportPassFindingsAsPr: no PASS findings to export")
  }

  const branch = `doppel/run-${input.runId.slice(0, 8)}`
  const baseSha = await client.getBranchSha(input.repo, input.baseBranch)
  await client.createBranch(input.repo, branch, baseSha)

  // §9: "apply patches grouped by DS component" — one commit per component,
  // each commit containing every file that component's findings touch.
  const byComponent = new Map<string, ExportFinding[]>()
  for (const f of passFindings) {
    const key = f.matchedComponent ?? "(unmatched)"
    if (!byComponent.has(key)) byComponent.set(key, [])
    byComponent.get(key)!.push(f)
  }

  for (const [component, componentFindings] of byComponent) {
    const byFile = new Map<string, ExportFinding[]>()
    for (const f of componentFindings) {
      if (!byFile.has(f.file)) byFile.set(f.file, [])
      byFile.get(f.file)!.push(f)
    }

    for (const [file, fileFindings] of byFile) {
      const existing = await client.getFileContent(input.repo, file, branch)
      if (!existing) {
        // A finding referencing a file that doesn't exist on the branch is a
        // real inconsistency (stale run against a repo that's since changed)
        // — skip it loudly rather than fabricate a new file from a JSX
        // fragment.
        console.error(`exportPassFindingsAsPr: ${file} not found on ${branch}, skipping ${fileFindings.length} finding(s)`)
        continue
      }

      let content = applyPatchesToFile(
        existing.content,
        fileFindings.map((f) => ({ line: f.line, endLine: f.endLine, patchedSource: f.patchedSource }))
      )
      const allImports = [...new Set(fileFindings.flatMap((f) => f.importsToAdd ?? []))]
      content = mergeImports(content, allImports)

      await client.putFile(input.repo, file, {
        base64Content: Buffer.from(content, "utf8").toString("base64"),
        message: `doppel: migrate ${fileFindings.length} ${component} instance(s) in ${file}`,
        branch,
        sha: existing.sha,
      })
    }
  }

  // Screenshots, committed after the code changes so their commit messages
  // read separately in the branch history.
  const bodyFindings: PrBodyFinding[] = []
  for (const f of passFindings) {
    const beforeB64 = dataUrlToBase64(f.beforeUrl)
    const afterB64 = dataUrlToBase64(f.afterUrl)
    const diffB64 = dataUrlToBase64(f.diffUrl)

    let beforeImageUrl: string | null = null
    let afterImageUrl: string | null = null
    let diffImageUrl: string | null = null

    if (beforeB64 && afterB64 && diffB64) {
      const beforePath = `${SCREENSHOT_DIR}/${f.id}-before.png`
      const afterPath = `${SCREENSHOT_DIR}/${f.id}-after.png`
      const diffPath = `${SCREENSHOT_DIR}/${f.id}-diff.png`
      await client.putFile(input.repo, beforePath, { base64Content: beforeB64, message: `doppel: verification screenshot for ${f.file}:${f.line}`, branch })
      await client.putFile(input.repo, afterPath, { base64Content: afterB64, message: `doppel: verification screenshot for ${f.file}:${f.line}`, branch })
      await client.putFile(input.repo, diffPath, { base64Content: diffB64, message: `doppel: verification screenshot for ${f.file}:${f.line}`, branch })
      beforeImageUrl = rawUrl(input.repo, branch, beforePath)
      afterImageUrl = rawUrl(input.repo, branch, afterPath)
      diffImageUrl = rawUrl(input.repo, branch, diffPath)
    }

    bodyFindings.push({
      file: f.file,
      line: f.line,
      matchedComponent: f.matchedComponent,
      verdict: f.verdict,
      deltaRatio: f.deltaRatio,
      beforeImageUrl,
      afterImageUrl,
      diffImageUrl,
    })
  }

  const pr = await client.createPullRequest(input.repo, {
    title: `Doppel: migrate ${passFindings.length} verified design-system drift finding(s)`,
    head: branch,
    base: input.baseBranch,
    body: buildPrBody(bodyFindings, input.runId),
  })

  return { branch, prNumber: pr.number, prUrl: pr.htmlUrl }
}

/**
 * POST /api/runs/[runId]/pr — CLAUDE.md §9's "Open PR": exports every PASS
 * finding on this run as a real branch + PR on a configured GitHub repo.
 *
 * Requires GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME in the
 * environment (GITHUB_BASE_BRANCH optional, defaults to "main") — same
 * "clearly not configured" pattern as DATABASE_URL elsewhere in this app,
 * not a silent no-op. No selection UI yet (§9 says "select PASS findings");
 * this exports ALL of a run's PASS findings in one call — a real, documented
 * v1 simplification, not the full spec.
 */

import { NextResponse } from "next/server"
import { eq, and } from "drizzle-orm"
import { getDb, findings } from "@doppel/db"
import { GitHubClient, exportPassFindingsAsPr } from "@doppel/github"

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params

  const token = process.env.GITHUB_TOKEN
  const owner = process.env.GITHUB_REPO_OWNER
  const repoName = process.env.GITHUB_REPO_NAME
  const baseBranch = process.env.GITHUB_BASE_BRANCH ?? "main"

  if (!token || !owner || !repoName) {
    return NextResponse.json(
      {
        error:
          "PR export isn't configured. Set GITHUB_TOKEN, GITHUB_REPO_OWNER, and GITHUB_REPO_NAME in .env — see .env.example.",
      },
      { status: 503 }
    )
  }

  const db = getDb()
  const passFindings = await db
    .select()
    .from(findings)
    .where(and(eq(findings.runId, runId), eq(findings.verdict, "PASS")))

  if (passFindings.length === 0) {
    return NextResponse.json({ error: "No PASS findings on this run to export." }, { status: 400 })
  }

  const client = new GitHubClient({ token })

  try {
    const result = await exportPassFindingsAsPr(client, {
      repo: { owner, repo: repoName },
      baseBranch,
      runId,
      findings: passFindings.map((f) => ({
        id: f.id,
        file: f.file,
        line: f.line,
        endLine: f.endLine,
        patchedSource: f.patchedSource ?? "",
        importsToAdd: f.importsToAdd,
        matchedComponent: f.matchedComponent,
        verdict: f.verdict,
        deltaRatio: f.deltaRatio,
        beforeUrl: f.beforeUrl,
        afterUrl: f.afterUrl,
        diffUrl: f.diffUrl,
      })),
    })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `PR export failed: ${message}` }, { status: 500 })
  }
}

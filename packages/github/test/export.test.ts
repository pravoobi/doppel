import { describe, expect, it, vi } from "vitest"
import { exportPassFindingsAsPr, type ExportFinding } from "../src/export"
import type { GitHubClient, RepoRef } from "../src/client"

const repo: RepoRef = { owner: "acme", repo: "widgets" }

function fakeClient(overrides: Partial<Record<keyof GitHubClient, unknown>> = {}) {
  const calls: { putFile: unknown[]; createBranch: unknown[] } = { putFile: [], createBranch: [] }

  const base = {
    getBranchSha: vi.fn(async () => "base-sha"),
    createBranch: vi.fn(async (...args: unknown[]) => {
      calls.createBranch.push(args)
    }),
    getFileContent: vi.fn(async () => ({
      content: 'import { Button } from "@/components/ui/button"\n\nexport default function Page() {\n  return <button>Click</button>\n}\n',
      base64Content: "irrelevant",
      sha: "file-sha",
    })),
    putFile: vi.fn(async (...args: unknown[]) => {
      calls.putFile.push(args)
    }),
    createPullRequest: vi.fn(async () => ({ number: 7, htmlUrl: "https://github.com/acme/widgets/pull/7" })),
    ...overrides,
  }

  return { client: base as unknown as GitHubClient, calls, base }
}

function baseFinding(overrides: Partial<ExportFinding> = {}): ExportFinding {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    file: "app/page.tsx",
    line: 4,
    endLine: 4,
    patchedSource: "<Button>Click</Button>",
    importsToAdd: ['import { Button } from "@/components/ui/button"'],
    matchedComponent: "Button",
    verdict: "PASS",
    deltaRatio: 0.001,
    beforeUrl: null,
    afterUrl: null,
    diffUrl: null,
    ...overrides,
  }
}

describe("exportPassFindingsAsPr", () => {
  it("throws when there are no PASS findings to export", async () => {
    const { client } = fakeClient()
    await expect(
      exportPassFindingsAsPr(client, { repo, baseBranch: "main", runId: "run-1", findings: [baseFinding({ verdict: "REVIEW" })] })
    ).rejects.toThrow(/no PASS findings/)
  })

  it("creates a branch named after the run id, from the base branch's sha", async () => {
    const { client, calls } = fakeClient()
    await exportPassFindingsAsPr(client, { repo, baseBranch: "main", runId: "abcdef1234567890", findings: [baseFinding()] })
    expect(calls.createBranch[0]).toEqual([repo, "doppel/run-abcdef12", "base-sha"])
  })

  it("only exports PASS findings, silently excluding REVIEW/FAIL/etc from the same run", async () => {
    const { client, calls } = fakeClient()
    await exportPassFindingsAsPr(client, {
      repo,
      baseBranch: "main",
      runId: "run-1",
      findings: [baseFinding(), baseFinding({ id: "2", verdict: "REVIEW", file: "app/other.tsx" })],
    })
    // Only one file's worth of putFile calls for the code change (app/page.tsx) — app/other.tsx never touched.
    const codeFileCalls = calls.putFile.filter((args) => (args as unknown[])[1] === "app/page.tsx")
    const otherFileCalls = calls.putFile.filter((args) => (args as unknown[])[1] === "app/other.tsx")
    expect(codeFileCalls.length).toBeGreaterThan(0)
    expect(otherFileCalls.length).toBe(0)
  })

  it("applies the patch and merges the import into the file content before committing", async () => {
    const { client, calls } = fakeClient()
    await exportPassFindingsAsPr(client, { repo, baseBranch: "main", runId: "run-1", findings: [baseFinding()] })
    const putCall = calls.putFile.find((args) => (args as unknown[])[1] === "app/page.tsx") as [RepoRef, string, { base64Content: string }]
    const committedContent = Buffer.from(putCall[2].base64Content, "base64").toString("utf8")
    expect(committedContent).toContain("<Button>Click</Button>")
  })

  it("skips a finding whose file doesn't exist on the branch, without throwing", async () => {
    const { client } = fakeClient({ getFileContent: vi.fn(async () => null) })
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await exportPassFindingsAsPr(client, { repo, baseBranch: "main", runId: "run-1", findings: [baseFinding()] })
    expect(result.prNumber).toBe(7)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not found"))
    consoleSpy.mockRestore()
  })

  it("commits before/after/diff screenshots and returns a PR result when images are present", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`
    const { client, calls } = fakeClient()
    const result = await exportPassFindingsAsPr(client, {
      repo,
      baseBranch: "main",
      runId: "run-1",
      findings: [baseFinding({ beforeUrl: dataUrl, afterUrl: dataUrl, diffUrl: dataUrl })],
    })
    const screenshotCalls = calls.putFile.filter((args) => String((args as unknown[])[1]).startsWith(".doppel/screenshots/"))
    expect(screenshotCalls.length).toBe(3)
    expect(result).toEqual({ branch: "doppel/run-run-1", prNumber: 7, prUrl: "https://github.com/acme/widgets/pull/7" })
  })

  it("does not attempt to commit screenshots when a finding has no images", async () => {
    const { client, calls } = fakeClient()
    await exportPassFindingsAsPr(client, { repo, baseBranch: "main", runId: "run-1", findings: [baseFinding()] })
    const screenshotCalls = calls.putFile.filter((args) => String((args as unknown[])[1]).startsWith(".doppel/screenshots/"))
    expect(screenshotCalls.length).toBe(0)
  })
})

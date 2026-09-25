/**
 * Thin GitHub REST API wrapper — plain fetch, no octokit, matching
 * packages/verifier/src/sandbox.ts's style (this codebase's convention for
 * external REST APIs: hit them directly rather than pull in an SDK for a
 * handful of endpoints). Covers exactly what PR export needs: read a ref,
 * create a branch, read/write file contents, open a PR. NOT a general GitHub
 * client — no pagination, no issues/webhooks/etc.
 */

const GITHUB_API_BASE = "https://api.github.com"

export type GitHubClientOptions = {
  token: string
  baseUrl?: string
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message)
    this.name = "GitHubApiError"
  }
}

export type RepoRef = { owner: string; repo: string }

export type FileContent = {
  /** Decoded UTF-8 text. Only correct for text files — callers dealing with binary content (screenshots) use base64Content instead. */
  content: string
  base64Content: string
  sha: string
}

export class GitHubClient {
  constructor(private readonly opts: GitHubClientOptions) {}

  private async request(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.opts.baseUrl ?? GITHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  }

  /** SHA of the commit a branch currently points at. */
  async getBranchSha(repo: RepoRef, branch: string): Promise<string> {
    const { status, body } = await this.request(`/repos/${repo.owner}/${repo.repo}/git/ref/heads/${branch}`)
    if (status !== 200) throw new GitHubApiError(`getBranchSha(${branch}) failed`, status, body)
    return (body as { object: { sha: string } }).object.sha
  }

  async createBranch(repo: RepoRef, newBranch: string, fromSha: string): Promise<void> {
    const { status, body } = await this.request(`/repos/${repo.owner}/${repo.repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: fromSha }),
    })
    if (status !== 201) throw new GitHubApiError(`createBranch(${newBranch}) failed`, status, body)
  }

  /** Null when the file doesn't exist on that ref yet (a new screenshot path, for instance). */
  async getFileContent(repo: RepoRef, path: string, ref: string): Promise<FileContent | null> {
    const { status, body } = await this.request(
      `/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`
    )
    if (status === 404) return null
    if (status !== 200) throw new GitHubApiError(`getFileContent(${path}) failed`, status, body)
    const raw = body as { content: string; sha: string }
    const base64Content = raw.content.replace(/\n/g, "")
    return { content: Buffer.from(base64Content, "base64").toString("utf8"), base64Content, sha: raw.sha }
  }

  /**
   * Creates or updates a file on `branch` via the Contents API (one commit
   * per call — fine at this volume; a real git-tree/commit-plumbing approach
   * would batch multiple file changes into one commit, not needed for the
   * handful of files a single PR export touches). `sha` is required when
   * updating an existing file, omitted when creating a new one.
   */
  async putFile(
    repo: RepoRef,
    path: string,
    input: { base64Content: string; message: string; branch: string; sha?: string }
  ): Promise<void> {
    const { status, body } = await this.request(
      `/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: input.message,
          content: input.base64Content,
          branch: input.branch,
          sha: input.sha,
        }),
      }
    )
    if (status !== 200 && status !== 201) throw new GitHubApiError(`putFile(${path}) failed`, status, body)
  }

  async createPullRequest(
    repo: RepoRef,
    input: { title: string; head: string; base: string; body: string }
  ): Promise<{ number: number; htmlUrl: string }> {
    const { status, body } = await this.request(`/repos/${repo.owner}/${repo.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify(input),
    })
    if (status !== 201) throw new GitHubApiError(`createPullRequest failed`, status, body)
    const raw = body as { number: number; html_url: string }
    return { number: raw.number, htmlUrl: raw.html_url }
  }
}

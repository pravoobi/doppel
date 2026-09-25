import { afterEach, describe, expect, it, vi } from "vitest"
import { GitHubApiError, GitHubClient } from "../src/client"

const repo = { owner: "acme", repo: "widgets" }

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GitHubClient", () => {
  it("getBranchSha returns the ref's commit sha", async () => {
    mockFetchOnce(200, { object: { sha: "abc123" } })
    const client = new GitHubClient({ token: "t" })
    await expect(client.getBranchSha(repo, "main")).resolves.toBe("abc123")
  })

  it("getBranchSha throws GitHubApiError on a non-200 response", async () => {
    mockFetchOnce(404, { message: "Not Found" })
    const client = new GitHubClient({ token: "t" })
    await expect(client.getBranchSha(repo, "nope")).rejects.toThrow(GitHubApiError)
  })

  it("createBranch posts the new ref against the given sha", async () => {
    let capturedBody: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        capturedBody = JSON.parse((init as RequestInit).body as string)
        return new Response(JSON.stringify({}), { status: 201 })
      })
    )
    const client = new GitHubClient({ token: "t" })
    await client.createBranch(repo, "doppel/run-1", "sha123")
    expect(capturedBody).toEqual({ ref: "refs/heads/doppel/run-1", sha: "sha123" })
  })

  it("getFileContent decodes base64 content and returns the blob sha", async () => {
    const base64 = Buffer.from("hello world", "utf8").toString("base64")
    mockFetchOnce(200, { content: base64, sha: "blobsha" })
    const client = new GitHubClient({ token: "t" })
    const result = await client.getFileContent(repo, "app/page.tsx", "main")
    expect(result).toEqual({ content: "hello world", base64Content: base64, sha: "blobsha" })
  })

  it("getFileContent returns null on a 404 instead of throwing", async () => {
    mockFetchOnce(404, { message: "Not Found" })
    const client = new GitHubClient({ token: "t" })
    await expect(client.getFileContent(repo, "missing.tsx", "main")).resolves.toBeNull()
  })

  it("putFile sends the sha when updating an existing file", async () => {
    let capturedBody: { sha?: string } = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        capturedBody = JSON.parse((init as RequestInit).body as string)
        return new Response(JSON.stringify({}), { status: 200 })
      })
    )
    const client = new GitHubClient({ token: "t" })
    await client.putFile(repo, "app/page.tsx", { base64Content: "xyz", message: "msg", branch: "b", sha: "existingsha" })
    expect(capturedBody.sha).toBe("existingsha")
  })

  it("putFile omits sha when creating a new file", async () => {
    let capturedBody: { sha?: string } = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        capturedBody = JSON.parse((init as RequestInit).body as string)
        return new Response(JSON.stringify({}), { status: 201 })
      })
    )
    const client = new GitHubClient({ token: "t" })
    await client.putFile(repo, ".doppel/screenshots/x.png", { base64Content: "xyz", message: "msg", branch: "b" })
    expect(capturedBody.sha).toBeUndefined()
  })

  it("createPullRequest returns the PR number and html url", async () => {
    mockFetchOnce(201, { number: 42, html_url: "https://github.com/acme/widgets/pull/42" })
    const client = new GitHubClient({ token: "t" })
    const result = await client.createPullRequest(repo, { title: "t", head: "h", base: "b", body: "body" })
    expect(result).toEqual({ number: 42, htmlUrl: "https://github.com/acme/widgets/pull/42" })
  })

  it("sends the bearer token and API version header on every request", async () => {
    let capturedHeaders: Headers | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        capturedHeaders = new Headers((init as RequestInit).headers)
        return new Response(JSON.stringify({ object: { sha: "x" } }), { status: 200 })
      })
    )
    const client = new GitHubClient({ token: "secret-token" })
    await client.getBranchSha(repo, "main")
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer secret-token")
    expect(capturedHeaders?.get("X-GitHub-Api-Version")).toBe("2022-11-28")
  })
})

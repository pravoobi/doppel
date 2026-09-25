import { describe, expect, it } from "vitest"
import { buildWriteFilesCommand, prefixFiles } from "../src/files.js"

describe("buildWriteFilesCommand", () => {
  it("round-trips file content through base64, including shell-special characters", () => {
    const content = "line one\nwith a 'quote' and a \"double quote\" and $pecial `ch@rs`\n"
    const command = buildWriteFilesCommand({ "a/b/file.txt": content })
    // Decode exactly the way the generated command does, to prove round-trip fidelity
    // without spending a real sandbox call.
    const base64Match = command.match(/echo '([^']+)' \| base64 -d/)
    expect(base64Match).not.toBeNull()
    const decoded = Buffer.from(base64Match![1], "base64").toString("utf8")
    expect(decoded).toBe(content)
  })

  it("creates the parent directory before writing", () => {
    const command = buildWriteFilesCommand({ "a/b/c/file.txt": "x" })
    expect(command).toContain('mkdir -p "a/b/c"')
  })

  it("writes a root-level file into the current directory", () => {
    const command = buildWriteFilesCommand({ "file.txt": "x" })
    expect(command).toContain('mkdir -p "."')
  })

  it("chains multiple files with &&, in a stable order", () => {
    const command = buildWriteFilesCommand({ "one.txt": "1", "two.txt": "2" })
    const oneIdx = command.indexOf("one.txt")
    const twoIdx = command.indexOf("two.txt")
    expect(oneIdx).toBeGreaterThanOrEqual(0)
    expect(oneIdx).toBeLessThan(twoIdx)
    expect(command).toContain(" && ")
  })
})

describe("prefixFiles", () => {
  it("prefixes every key with the given directory", () => {
    const result = prefixFiles({ "index.html": "<html></html>", "src/main.tsx": "code" }, "harness")
    expect(Object.keys(result).sort()).toEqual(["harness/index.html", "harness/src/main.tsx"])
    expect(result["harness/index.html"]).toBe("<html></html>")
  })
})

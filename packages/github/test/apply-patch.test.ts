import { describe, expect, it } from "vitest"
import { applyPatchesToFile, mergeImports } from "../src/apply-patch"

describe("applyPatchesToFile", () => {
  it("replaces a single line range with the patched source, preserving indentation", () => {
    const content = ["function App() {", "  return (", "    <button>Click</button>", "  )", "}"].join("\n")
    const result = applyPatchesToFile(content, [{ line: 3, endLine: 3, patchedSource: "<Button>Click</Button>" }])
    expect(result).toBe(["function App() {", "  return (", "    <Button>Click</Button>", "  )", "}"].join("\n"))
  })

  it("replaces a multi-line range with a multi-line replacement", () => {
    const content = ["const x = (", "  <div>", "    <span>hi</span>", "  </div>", ")"].join("\n")
    const result = applyPatchesToFile(content, [{ line: 2, endLine: 4, patchedSource: "<Card>hi</Card>" }])
    expect(result).toBe(["const x = (", "  <Card>hi</Card>", ")"].join("\n"))
  })

  it("applies multiple non-overlapping patches in one pass without either shifting the other's line numbers", () => {
    const content = ["line1", "line2 TARGET_A", "line3", "line4 TARGET_B", "line5"].join("\n")
    const result = applyPatchesToFile(content, [
      { line: 2, endLine: 2, patchedSource: "line2 PATCHED_A" },
      { line: 4, endLine: 4, patchedSource: "line4 PATCHED_B" },
    ])
    expect(result).toBe(["line1", "line2 PATCHED_A", "line3", "line4 PATCHED_B", "line5"].join("\n"))
  })

  it("throws on overlapping patch ranges instead of silently picking one", () => {
    const content = ["a", "b", "c", "d"].join("\n")
    expect(() =>
      applyPatchesToFile(content, [
        { line: 1, endLine: 3, patchedSource: "X" },
        { line: 2, endLine: 4, patchedSource: "Y" },
      ])
    ).toThrow(/overlapping/)
  })

  it("throws when a patch range is out of bounds for the file", () => {
    const content = ["a", "b"].join("\n")
    expect(() => applyPatchesToFile(content, [{ line: 5, endLine: 5, patchedSource: "X" }])).toThrow(/out of bounds/)
  })
})

describe("mergeImports", () => {
  it("inserts a missing import after the existing import block", () => {
    const content = ['import React from "react"', "", "export default function App() {}"].join("\n")
    const result = mergeImports(content, ['import { Button } from "@/components/ui/button"'])
    expect(result).toBe(
      ['import React from "react"', 'import { Button } from "@/components/ui/button"', "", "export default function App() {}"].join("\n")
    )
  })

  it("does not duplicate an import that's already present", () => {
    const content = ['import { Button } from "@/components/ui/button"', "", "export default function App() {}"].join("\n")
    const result = mergeImports(content, ['import { Button } from "@/components/ui/button"'])
    expect(result).toBe(content)
  })

  it("inserts at the top when the file has no existing imports", () => {
    const content = "export default function App() {}"
    const result = mergeImports(content, ['import { Button } from "@/components/ui/button"'])
    expect(result).toBe(['import { Button } from "@/components/ui/button"', "export default function App() {}"].join("\n"))
  })

  it("inserts after a leading \"use client\" directive, not before it", () => {
    const content = ['"use client"', "", "export default function App() {}"].join("\n")
    const result = mergeImports(content, ['import { Button } from "@/components/ui/button"'])
    expect(result.split("\n")[0]).toBe('"use client"')
    expect(result).toContain('import { Button } from "@/components/ui/button"')
  })

  it("returns the content unchanged when there's nothing to add", () => {
    const content = "export default function App() {}"
    expect(mergeImports(content, [])).toBe(content)
  })
})

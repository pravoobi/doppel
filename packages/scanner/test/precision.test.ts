/**
 * The M1 gate (CLAUDE.md §10): the scanner must reach >=80% precision with
 * 100% recall across all 18 planted cases in fixtures/drift-demo, no LLM
 * involved. Ground truth comes from fixtures/drift-demo/EXPECTED.json, which
 * is generated — never hand-edit expected values here, edit the fixture's own
 * generator instead.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"
import { buildDsIndex } from "../src/index-ds.js"
import { extractCandidates, shortlistCandidates } from "../src/extract.js"
import type { ShortlistedCandidate } from "@doppel/shared"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/drift-demo")

type ExpectedCase = {
  id: string
  file: string
  line: number | null
  rootTag: string
  expect: {
    detected: boolean
    matchedComponent?: string | null
    verdict?: string | null
  }
}

type ExpectedNegative = {
  id: string
  file: string
  line: number | null
}

type ExpectedJson = {
  targets: {
    detectionRecall: number
    minPrecision: number
    maxFalsePositives: number
    lineMatchTolerance: number
  }
  cases: ExpectedCase[]
  negatives: ExpectedNegative[]
}

function loadExpected(): ExpectedJson {
  const raw = fs.readFileSync(path.join(FIXTURE_ROOT, "EXPECTED.json"), "utf8")
  return JSON.parse(raw)
}

function runScanner(): ShortlistedCandidate[] {
  const dsDirAbsPath = path.join(FIXTURE_ROOT, "components/ui")
  const tsConfigFilePath = path.join(FIXTURE_ROOT, "tsconfig.json")

  const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true })
  project.addSourceFilesAtPaths(`${FIXTURE_ROOT.replace(/\\/g, "/")}/**/*.tsx`)

  const dsIndex = buildDsIndex(project, dsDirAbsPath)
  const knownComponents = dsIndex.components.map((c) => c.name)
  const candidates = extractCandidates(project, { dsDirAbsPath })
  return shortlistCandidates(candidates, knownComponents)
}

function absFile(fixtureRelFile: string): string {
  return path.join(FIXTURE_ROOT, fixtureRelFile).replace(/\\/g, "/")
}

function matchesPosition(
  candidate: ShortlistedCandidate,
  file: string,
  line: number,
  tolerance: number
): boolean {
  return (
    candidate.file.replace(/\\/g, "/") === absFile(file) &&
    Math.abs(candidate.line - line) <= tolerance
  )
}

describe("scanner precision against fixtures/drift-demo", () => {
  const expected = loadExpected()
  const shortlisted = runScanner()
  const tolerance = expected.targets.lineMatchTolerance

  it("extracted at least one candidate", () => {
    expect(shortlisted.length).toBeGreaterThan(0)
  })

  it(`meets detection recall >= ${expected.targets.detectionRecall} across all cases`, () => {
    const misses: string[] = []

    for (const c of expected.cases) {
      if (!c.expect.detected || c.line === null) continue
      const hit = shortlisted.some((s) => {
        if (!matchesPosition(s, c.file, c.line!, tolerance)) return false
        if (!c.expect.matchedComponent) return true
        return s.shortlist.includes(c.expect.matchedComponent)
      })
      if (!hit) misses.push(`${c.id} (${c.file}:${c.line}, expected ${c.expect.matchedComponent})`)
    }

    if (misses.length > 0) {
      console.error("Missed cases:\n  " + misses.join("\n  "))
    }

    const recall = (expected.cases.length - misses.length) / expected.cases.length
    expect(recall).toBeGreaterThanOrEqual(expected.targets.detectionRecall)
  })

  it(`meets precision >= ${expected.targets.minPrecision}`, () => {
    let truePositives = 0
    const falsePositives: string[] = []

    for (const s of shortlisted) {
      const matchesKnownCase = expected.cases.some(
        (c) => c.line !== null && matchesPosition(s, c.file, c.line, tolerance)
      )
      if (matchesKnownCase) {
        truePositives++
      } else {
        const relFile = path.relative(FIXTURE_ROOT, s.file).replace(/\\/g, "/")
        falsePositives.push(`${relFile}:${s.line} <${s.fingerprint.rootTag}> → ${s.shortlist.join(",")}`)
      }
    }

    if (falsePositives.length > 0) {
      console.error("False positives:\n  " + falsePositives.join("\n  "))
    }

    const precision = truePositives / shortlisted.length
    expect(precision).toBeGreaterThanOrEqual(expected.targets.minPrecision)
    expect(falsePositives.length).toBeLessThanOrEqual(expected.targets.maxFalsePositives)
  })

  it("never flags a known negative", () => {
    const flaggedNegatives: string[] = []

    for (const n of expected.negatives) {
      if (n.line === null) continue
      const hit = shortlisted.find((s) => matchesPosition(s, n.file, n.line!, tolerance))
      if (hit) {
        flaggedNegatives.push(`${n.id} (${n.file}:${n.line}) matched by candidate at line ${hit.line}`)
      }
    }

    if (flaggedNegatives.length > 0) {
      console.error("Flagged negatives:\n  " + flaggedNegatives.join("\n  "))
    }

    // Negatives are asserted separately from the general precision budget so a
    // regression here is unambiguous in the test output, not buried in the
    // overall false-positive count.
    expect(flaggedNegatives.length).toBe(0)
  })
})

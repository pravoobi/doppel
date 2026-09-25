#!/usr/bin/env node
/**
 * CLI: prints ranked drift candidates for a repo. Deterministic, zero LLM calls.
 * This is the M1 gate artifact (CLAUDE.md §10): `doppel-scan` on the fixture
 * must print candidates covering all 18 planted cases at >=80% precision.
 *
 * Usage:
 *   pnpm cli -- --root ../../fixtures/drift-demo --ds components/ui
 */

import fs from "node:fs"
import path from "node:path"
import { Project } from "ts-morph"
import { buildDsIndex } from "./index-ds"
import { extractCandidates, shortlistCandidates } from "./extract"

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2)
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"
      args[key] = value
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(args.root ?? ".")
  const dsRelPath = args.ds ?? "components/ui"
  const dsDirAbsPath = path.resolve(root, dsRelPath)

  const project = new Project({
    tsConfigFilePath: findTsconfig(root),
    skipAddingFilesFromTsConfig: true,
  })
  project.addSourceFilesAtPaths([
    `${root.replace(/\\/g, "/")}/**/*.tsx`,
    `!${root.replace(/\\/g, "/")}/node_modules/**`,
  ])

  const dsIndex = buildDsIndex(project, dsDirAbsPath)
  console.log(`\nDesign system: ${dsRelPath} (${dsIndex.components.length} components)`)
  for (const c of dsIndex.components) {
    const variantKeys = Object.keys(c.variants)
    console.log(`  - ${c.name}  (${c.props.length} props${variantKeys.length ? `, variants: ${variantKeys.join(", ")}` : ""})`)
  }

  const knownComponents = dsIndex.components.map((c) => c.name)
  const candidates = extractCandidates(project, { dsDirAbsPath })
  const shortlisted = shortlistCandidates(candidates, knownComponents)

  console.log(
    `\nExtracted ${candidates.length} raw candidates, ${shortlisted.length} shortlisted ` +
      `(${candidates.length - shortlisted.length} filtered before inference)\n`
  )

  const sorted = [...shortlisted].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
  )

  for (const c of sorted) {
    const relFile = path.relative(root, c.file).replace(/\\/g, "/")
    console.log(
      `  ${relFile}:${c.line}  <${c.fingerprint.rootTag}>  → ${c.shortlist.join(", ")}` +
        (c.fingerprint.textSample ? `  "${c.fingerprint.textSample}"` : "")
    )
  }
  console.log("")
}

function findTsconfig(root: string): string | undefined {
  const p = path.join(root, "tsconfig.json")
  return fs.existsSync(p) ? p : undefined
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

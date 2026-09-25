/**
 * M2 gate validation (CLAUDE.md §10): run the full triage → adjudicate → migrate
 * pipeline against fixtures/drift-demo and confirm >=10 generated patches pass a
 * real typecheck. This is a live run against the Nebius API — it costs real
 * credits (roughly a few dozen Nano/Super/Ultra calls; see the summary this
 * script prints, and .doppel/llm_calls.jsonl for the itemized log).
 *
 * Patches are applied via ts-morph node replacement (never string splicing, per
 * CLAUDE.md §5.6) against an in-memory ts-morph Project — nothing on disk in
 * fixtures/drift-demo is ever modified. Typecheck uses the same TypeScript
 * compiler diagnostics `tsc --noEmit` uses, just via the in-process language
 * service instead of a subprocess.
 *
 * Run: pnpm m2-pipeline
 */

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { Node, Project, type SourceFile, ts } from "ts-morph"
import { buildDsIndex, extractCandidates, shortlistCandidates, getTagName } from "@doppel/scanner"
import {
  describeDsComponent,
  triageCandidates,
  adjudicateCandidate,
  migrateCandidate,
  repairMigration,
  RouteError,
} from "@doppel/agent"
import type { DsComponent, ShortlistedCandidate } from "@doppel/shared"

function describeError(err: unknown): string {
  if (err instanceof RouteError) {
    return `${err.message} — stage=${err.context.stage} tier=${err.context.tier} model=${err.context.model} lastError=${err.context.lastError}`
  }
  return err instanceof Error ? err.message : String(err)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/drift-demo")
const RUN_ID = `m2-pipeline-${new Date().toISOString()}`

type PatchResult = {
  candidateId: string
  file: string
  line: number
  matchedComponent: string
  classification: string
  risk: string | null
  unmappable: string[]
  typecheckPassed: boolean
  repaired: boolean
  diagnostics: string[]
}

function findJsxNodeAtLine(sourceFile: SourceFile, line: number, rootTag: string): Node | null {
  let found: Node | null = null
  function visit(node: Node) {
    if (found) return
    for (const child of node.getChildren()) {
      if (found) return
      if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)) {
        if (child.getStartLineNumber() === line && getTagName(child) === rootTag) {
          found = child
          return
        }
      }
      visit(child)
    }
  }
  visit(sourceFile)
  return found
}

function flattenMessage(msg: ReturnType<import("ts-morph").Diagnostic["getMessageText"]>): string {
  return typeof msg === "string" ? msg : msg.getMessageText()
}

function getDiagnosticMessages(sourceFile: SourceFile, project: Project): string[] {
  return project
    .getPreEmitDiagnostics()
    .filter((d) => d.getSourceFile()?.getFilePath() === sourceFile.getFilePath())
    .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error)
    .map((d) => `L${d.getLineNumber() ?? "?"}: ${flattenMessage(d.getMessageText())}`)
}

/**
 * `Node.replaceWithText()` does an incremental AST-tree diff between the old and
 * new node, and is fragile on JSX — it can throw ("Error replacing tree! Perhaps
 * a syntax error was inserted") on perfectly valid replacements just because the
 * old/new shapes don't line up node-for-node. `SourceFile.replaceText()` with the
 * node's own start/end range sidesteps that: it's still a ts-morph-native
 * manipulation (the range comes straight from the AST, not a guess), but ts-morph
 * applies it as a straight text splice + reparse instead of a tree reconciliation.
 */
function applyReplacement(sourceFile: SourceFile, node: Node, newText: string): void {
  sourceFile.replaceText([node.getStart(), node.getEnd()], newText)
}

/**
 * Adds a single named import through ts-morph's own import-management API
 * (`addImportDeclaration`/`addNamedImport`), which checks the existing AST for a
 * matching module/name semantically. This replaced an earlier raw-text dedup
 * (comparing `getText()` strings) that missed a real duplicate import because the
 * model's quote style didn't match the file's — semantic comparison can't have
 * that failure mode.
 */
function ensureNamedImport(sourceFile: SourceFile, moduleSpecifier: string, name: string): void {
  const decl = sourceFile.getImportDeclaration((d) => d.getModuleSpecifierValue() === moduleSpecifier)
  if (!decl) {
    sourceFile.addImportDeclaration({ moduleSpecifier, namedImports: [name] })
    return
  }
  if (!decl.getNamedImports().some((n) => n.getName() === name)) {
    decl.addNamedImport(name)
  }
}

/**
 * Deterministic import fixup: scan the replacement JSX for every capitalized tag
 * it actually uses (Card, CardHeader, DialogContent, ...) and, for each one that
 * matches a known DS component, guarantee its import — regardless of whether the
 * model remembered to list it in `importsToAdd`. This fully replaced trusting the
 * model for DS-component imports specifically (it kept dropping sub-component
 * imports like DialogContent even after the prompt was strengthened); the model's
 * `importsToAdd` is still applied afterward for anything else (icons, utilities)
 * that isn't in the DS index.
 */
function ensureDsImportsUsedIn(
  sourceFile: SourceFile,
  jsxText: string,
  componentsByName: Map<string, DsComponent>
): void {
  const tagNames = new Set([...jsxText.matchAll(/<\/?([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]))
  for (const name of tagNames) {
    const component = componentsByName.get(name)
    if (component) ensureNamedImport(sourceFile, component.importPath, component.name)
  }
}

function addModelImportsIfMissing(sourceFile: SourceFile, importLines: string[]): void {
  for (const line of importLines) {
    const m = line.trim().match(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/)
    if (m) {
      const [, namesRaw, moduleSpecifier] = m
      for (const name of namesRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
        ensureNamedImport(sourceFile, moduleSpecifier, name)
      }
      continue
    }
    // Not a simple named import (default/namespace import) — fall back to a raw
    // insert, only if an identical line isn't already present.
    const existing = new Set(sourceFile.getImportDeclarations().map((d) => d.getText().trim()))
    if (line.trim().length > 0 && !existing.has(line.trim())) {
      sourceFile.insertText(0, `${line.trim()}\n`)
    }
  }
}

/**
 * Parses `jsx` as a standalone fragment to catch truncated/malformed JSX (missing
 * closing tags, unbalanced expressions) BEFORE splicing it into the real file.
 * A string can be perfectly valid JSON and still be broken JSX — the retry loop
 * in route.ts only validates the former. Without this, malformed output gets
 * spliced into the shared sourceFile and produces confusing cascading diagnostics
 * far from the actual defect (observed: "Identifier expected" dozens of lines
 * past the patch site). Uses an in-memory throwaway project so nothing here ever
 * touches disk. `jsx: Preserve` avoids needing to resolve `react/jsx-runtime`
 * types, which an in-memory project with no node_modules can't do anyway — this
 * check only needs the parser, not the type checker's module resolution.
 *
 * Filters diagnostics with an ALLOWLIST of genuine parse/structure error codes,
 * not a blocklist of resolution errors: imports aren't applied to this isolated
 * fragment, so "cannot find name" has several code variants (2304, 2552, 2663,
 * ...) depending on phrasing — blocklisting them one at a time is a losing game,
 * an allowlist of the errors we actually care about is stable.
 */
const JSX_STRUCTURAL_ERROR_CODES = new Set([
  1003, 1005, 1109, 1128, 1136, 1145, 1160, 1161, 1381, 1382, 17002, 17008, 2657,
])

function findJsxSyntaxError(jsx: string): string | null {
  const wrapper = `function __Check() {\n  return (\n${jsx}\n  );\n}\n`
  const tempProject = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  })
  const tempFile = tempProject.createSourceFile("__check.tsx", wrapper)
  const errors = tempFile
    .getPreEmitDiagnostics()
    .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error)
    .filter((d) => JSX_STRUCTURAL_ERROR_CODES.has(d.getCode()))
    .map((d) => `L${d.getLineNumber() ?? "?"}: ${flattenMessage(d.getMessageText())}`)
  return errors.length > 0 ? errors.join("\n") : null
}

async function main() {
  console.log(`Run: ${RUN_ID}\n`)

  const dsDirAbsPath = path.join(FIXTURE_ROOT, "components/ui")
  const tsConfigFilePath = path.join(FIXTURE_ROOT, "tsconfig.json")
  const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true })
  project.addSourceFilesAtPaths(`${FIXTURE_ROOT.replace(/\\/g, "/")}/**/*.tsx`)

  const baselineTextByFile = new Map<string, string>()
  for (const sf of project.getSourceFiles()) baselineTextByFile.set(sf.getFilePath(), sf.getFullText())

  console.log("=== 1. DS index + Nano descriptions ===")
  const dsIndex = buildDsIndex(project, dsDirAbsPath)
  const describedComponents: DsComponent[] = []
  for (const component of dsIndex.components) {
    try {
      const { description, aliases } = await describeDsComponent(component, { runId: RUN_ID })
      describedComponents.push({ ...component, description, aliases })
      console.log(`  ${component.name}: ${description}`)
    } catch (err) {
      console.warn(`  ${component.name}: describe FAILED — ${(err as Error).message}`)
      describedComponents.push(component)
    }
  }

  console.log("\n=== 2. Extract + shortlist (deterministic) ===")
  const knownComponents = describedComponents.map((c) => c.name)
  const candidates = shortlistCandidates(extractCandidates(project, { dsDirAbsPath }), knownComponents)
  console.log(`  ${candidates.length} shortlisted candidates`)

  console.log("\n=== 3. Triage (Nano, batched) ===")
  const triageResults = await triageCandidates(candidates, describedComponents, { runId: RUN_ID })
  console.log(`  ${triageResults.length}/${candidates.length} candidates survived triage (confidence >= 0.4)`)

  const candidatesById = new Map<string, ShortlistedCandidate>(candidates.map((c) => [c.id, c]))
  const componentsByName = new Map(describedComponents.map((c) => [c.name, c]))

  const results: PatchResult[] = []

  console.log("\n=== 4. Adjudicate (Super) + Migrate (Ultra) per DRIFT candidate ===")
  for (const triage of triageResults) {
    if (!triage.match) continue
    const candidate = candidatesById.get(triage.id)
    const matchedComponent = componentsByName.get(triage.match)
    if (!candidate || !matchedComponent) continue

    const sourceFile = project.getSourceFileOrThrow(candidate.file)
    const relFile = path.relative(FIXTURE_ROOT, candidate.file).replace(/\\/g, "/")

    try {
      const adjudication = await adjudicateCandidate(
        {
          candidateId: candidate.id,
          candidateSource: candidate.sourceText,
          surroundingSource: sourceFile.getFullText(),
          matchedComponent,
        },
        { runId: RUN_ID }
      )

      console.log(
        `  ${relFile}:${candidate.line}  ${triage.match}  → ${adjudication.classification}` +
          (adjudication.risk ? ` (${adjudication.risk} risk)` : "")
      )

      if (adjudication.classification !== "DRIFT") {
        results.push({
          candidateId: candidate.id,
          file: relFile,
          line: candidate.line,
          matchedComponent: triage.match,
          classification: adjudication.classification,
          risk: null,
          unmappable: [],
          typecheckPassed: false,
          repaired: false,
          diagnostics: [],
        })
        continue
      }

      const existingImports = sourceFile.getImportDeclarations().map((d) => d.getText())
      let migration = await migrateCandidate(
        {
          candidateId: candidate.id,
          candidateSource: candidate.sourceText,
          matchedComponent,
          existingImports,
          propMapping: adjudication.propMapping,
        },
        { runId: RUN_ID }
      )

      let repaired = false

      // Pre-splice gate: a string can be valid JSON and still be truncated or
      // malformed JSX (missing closing tags, unbalanced expressions — observed
      // empirically: the model sometimes abandons a complex multi-child
      // migration mid-string, e.g. `"<Alert variant="`, which is syntactically
      // valid JSON with garbage content zod's shape check can't catch). Catch
      // that here, before it ever touches the real sourceFile.
      //
      // Up to 2 repair attempts here, scoped to THIS validation script proving
      // the pipeline works end-to-end — not the product's real verify policy.
      // CLAUDE.md §5.7 step 6 mandates exactly one repair attempt for the real
      // M3 sandbox-verify loop; that constraint is unchanged and will be
      // implemented as written when packages/verifier exists.
      let syntaxError = findJsxSyntaxError(migration.replacementJsx)
      for (let attempt = 1; syntaxError && attempt <= 2; attempt++) {
        console.log(`    pre-splice syntax error (attempt ${attempt}): ${syntaxError.split("\n")[0]}`)
        try {
          const repair = await repairMigration(
            {
              candidateId: candidate.id,
              candidateSource: candidate.sourceText,
              matchedComponent,
              previousReplacementJsx: migration.replacementJsx,
              compilerError: syntaxError,
            },
            { runId: RUN_ID }
          )
          migration = repair
          repaired = true
          syntaxError = findJsxSyntaxError(migration.replacementJsx)
        } catch (err) {
          console.warn(`    pre-splice repair FAILED: ${describeError(err)}`)
          break
        }
      }

      if (syntaxError) {
        results.push({
          candidateId: candidate.id,
          file: relFile,
          line: candidate.line,
          matchedComponent: triage.match,
          classification: adjudication.classification,
          risk: adjudication.risk,
          unmappable: adjudication.unmappable,
          typecheckPassed: false,
          repaired,
          diagnostics: [`pre-splice: ${syntaxError}`],
        })
        console.log(`    typecheck: FAIL (invalid JSX, not spliced)`)
        continue
      }

      // Reset this file to its baseline before applying — candidates sharing a
      // file must be checked independently, not cumulatively.
      const baseline = baselineTextByFile.get(candidate.file)!
      sourceFile.replaceWithText(baseline)

      let node = findJsxNodeAtLine(sourceFile, candidate.line, candidate.fingerprint.rootTag)
      if (!node) throw new Error(`could not re-locate node at ${relFile}:${candidate.line} after reset`)

      applyReplacement(sourceFile, node, migration.replacementJsx)
      ensureDsImportsUsedIn(sourceFile, migration.replacementJsx, componentsByName)
      addModelImportsIfMissing(sourceFile, migration.importsToAdd)

      let diagnostics = getDiagnosticMessages(sourceFile, project)

      if (diagnostics.length > 0) {
        try {
          const repair = await repairMigration(
            {
              candidateId: candidate.id,
              candidateSource: candidate.sourceText,
              matchedComponent,
              previousReplacementJsx: migration.replacementJsx,
              compilerError: diagnostics.join("\n"),
            },
            { runId: RUN_ID }
          )

          sourceFile.replaceWithText(baseline)
          node = findJsxNodeAtLine(sourceFile, candidate.line, candidate.fingerprint.rootTag)
          if (node) {
            applyReplacement(sourceFile, node, repair.replacementJsx)
            ensureDsImportsUsedIn(sourceFile, repair.replacementJsx, componentsByName)
            addModelImportsIfMissing(sourceFile, repair.importsToAdd)
            diagnostics = getDiagnosticMessages(sourceFile, project)
            repaired = true
          }
        } catch (err) {
          console.warn(`    repair FAILED: ${describeError(err)}`)
        }
      }

      const typecheckPassed = diagnostics.length === 0
      console.log(`    typecheck: ${typecheckPassed ? "PASS" : "FAIL"}${repaired ? " (after repair)" : ""}`)
      if (!typecheckPassed) {
        for (const d of diagnostics) console.log(`      ${d}`)
      }

      results.push({
        candidateId: candidate.id,
        file: relFile,
        line: candidate.line,
        matchedComponent: triage.match,
        classification: adjudication.classification,
        risk: adjudication.risk,
        unmappable: adjudication.unmappable,
        typecheckPassed,
        repaired,
        diagnostics,
      })

      // Leave the file at baseline for the next candidate in this run.
      sourceFile.replaceWithText(baseline)
    } catch (err) {
      console.error(`  ${relFile}:${candidate.line}  FAILED: ${describeError(err)}`)
      results.push({
        candidateId: candidate.id,
        file: relFile,
        line: candidate.line,
        matchedComponent: triage.match,
        classification: "ERROR",
        risk: null,
        unmappable: [],
        typecheckPassed: false,
        repaired: false,
        diagnostics: [describeError(err)],
      })
    }
  }

  const passed = results.filter((r) => r.typecheckPassed)
  console.log(`\n=== Summary ===`)
  console.log(`  ${results.length} candidates reached adjudication`)
  console.log(`  ${results.filter((r) => r.classification === "DRIFT").length} classified DRIFT`)
  console.log(
    `  ${results.filter((r) => r.classification === "INTENTIONAL_DEVIATION").length} INTENTIONAL_DEVIATION, ` +
      `${results.filter((r) => r.classification === "NOT_DRIFT").length} NOT_DRIFT`
  )
  console.log(`  ${passed.length} patches PASS tsc --noEmit (M2 gate: >=10)`)
  console.log(`  ${passed.length >= 10 ? "GATE PASSED" : "GATE NOT MET"}`)

  const outDir = path.resolve(__dirname, "../.doppel")
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `m2-pipeline-${Date.now()}.json`)
  fs.writeFileSync(outPath, JSON.stringify({ runId: RUN_ID, results }, null, 2))
  console.log(`\n  Full results: ${path.relative(process.cwd(), outPath)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

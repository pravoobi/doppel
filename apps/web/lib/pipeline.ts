/**
 * The real run orchestrator — ties packages/scanner → packages/agent →
 * packages/verifier together and persists results to Postgres via @doppel/db.
 * This is what `scripts/m2-pipeline.ts`/`m3-pipeline.ts` proved work
 * independently, now wired end to end against a real run record instead of
 * console output, so the dashboard has real data to read.
 *
 * Verify (M3) scope cut: it only knows how to build a harness for THIS repo
 * shape (see verify-run.ts's own header) — repoRoot only ever points at the
 * fixture right now anyway (cloning isn't implemented, see RunPipelineInput
 * below), so this isn't a regression, just an honest boundary on what's
 * generic. When NEBIUS_API_KEY/NEBIUS_PROJECT_ID aren't set, or a candidate's
 * JSX can't render standalone, the finding still gets `verdict: null`
 * ("not yet verified") or `UNVERIFIABLE` respectively — never a guess.
 */

import { Project } from "ts-morph"
import { buildDsIndex, extractCandidates, shortlistCandidates } from "@doppel/scanner"
import { describeDsComponent, triageCandidates, adjudicateCandidate, migrateCandidate } from "@doppel/agent"
import { setUsageSink, JsonlUsageSink } from "@doppel/agent"
import { getDb, runs, findings, DrizzleUsageSink, type NewFinding, type Run } from "@doppel/db"
import type { DsComponent, ShortlistedCandidate } from "@doppel/shared"
import { eq } from "drizzle-orm"
import fs from "node:fs"
import path from "node:path"
import { RunVerifier, createSandboxClientFromEnv, wrapAsStandaloneComponent } from "./verify-run"
import type { VerifyResult } from "@doppel/verifier"

export type RunPipelineInput = {
  /** Local filesystem path to the (already-available) repo — cloning isn't implemented yet, see docs/DECISIONS.md. */
  repoRoot: string
  /** Recorded on the run for display; not fetched from — repoRoot is the actual source. */
  repoUrl: string
  ref?: string
  /** Relative to repoRoot, e.g. "components/ui". Matches CLAUDE.md §5.1's detection order — explicit path first. */
  dsPath: string
}

/**
 * In-memory `tsc --noEmit` on the EXACT wrapper content verify-run.ts renders
 * (via `wrapAsStandaloneComponent`) — never written to disk, so it can't leak
 * into a later scan or collide across candidates. Reuses the run's own
 * ts-morph `Project` (already configured with the repo's tsconfig, so `@/*`
 * path aliases resolve against real DS component files) rather than spinning
 * up a second one per candidate.
 */
function typecheckWrapper(project: Project, repoRoot: string, wrapperContent: string): { passed: boolean; messages: string[] } {
  const checkPath = path.join(repoRoot, `.doppel-harness-check-${Date.now()}-${Math.random().toString(36).slice(2)}.tsx`)
  const sourceFile = project.createSourceFile(checkPath, wrapperContent, { overwrite: true })
  try {
    const diagnostics = sourceFile.getPreEmitDiagnostics()
    return {
      passed: diagnostics.length === 0,
      messages: diagnostics.map((d) => `TS${d.getCode()}: ${d.getMessageText()}`),
    }
  } finally {
    project.removeSourceFile(sourceFile)
  }
}

const IMAGE_VIEWPORT = 768 // representative viewport stored on the finding — schema has one before/after/diff slot, not one per viewport

function pngToDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`
}

/** Maps a verify.ts result onto the findings table's verdict/deltaRatio/verifyLog/*Url columns. */
function verifyResultToFindingFields(result: VerifyResult): Partial<NewFinding> {
  const viewport = result.viewportResults.find((v) => v.viewport === IMAGE_VIEWPORT) ?? result.viewportResults[0]
  const deltaRatio = result.viewportResults.length > 0 ? Math.max(...result.viewportResults.map((v) => v.deltaRatio)) : undefined

  const verifyLog = [
    `verdict: ${result.verdict}`,
    result.errorMessage ? `error: ${result.errorMessage}` : null,
    "--- setup ---",
    result.setupLog,
    "--- before render ---",
    result.beforeRenderLog,
    "--- after render ---",
    result.afterRenderLog,
  ]
    .filter((s): s is string => s !== null)
    .join("\n")
    .slice(0, 50_000) // debugging log, not shown to end users — cap against sandbox output being large

  return {
    verdict: result.verdict,
    deltaRatio,
    verifyLog,
    beforeUrl: viewport ? pngToDataUrl(viewport.beforePng) : undefined,
    afterUrl: viewport ? pngToDataUrl(viewport.afterPng) : undefined,
    diffUrl: viewport ? pngToDataUrl(viewport.diffPng) : undefined,
  }
}

/** Fast: just the insert. Callers that can't await the whole run (API routes) await this, then fire `executeRun` without awaiting it. */
export async function createRun(input: RunPipelineInput): Promise<Run> {
  const db = getDb()
  const [run] = await db
    .insert(runs)
    .values({ repoUrl: input.repoUrl, ref: input.ref, dsPath: input.dsPath, status: "running" })
    .returning()
  return run
}

/** The long-running part. Never throws — a failed run is recorded via `status: "failed"`, not a rejected promise, since callers commonly fire this without awaiting it. */
export async function executeRun(run: Run, input: RunPipelineInput): Promise<void> {
  const db = getDb()

  try {
    setUsageSink(new DrizzleUsageSink(db, run.id))

    const dsDirAbsPath = path.resolve(input.repoRoot, input.dsPath)
    const tsConfigPath = path.join(input.repoRoot, "tsconfig.json")
    const project = new Project({
      tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
      skipAddingFilesFromTsConfig: true,
    })
    project.addSourceFilesAtPaths(`${input.repoRoot.replace(/\\/g, "/")}/**/*.tsx`)

    const dsIndex = buildDsIndex(project, dsDirAbsPath)
    const rawCandidates = extractCandidates(project, { dsDirAbsPath })
    const describedComponents: DsComponent[] = []
    for (const component of dsIndex.components) {
      try {
        const { description, aliases } = await describeDsComponent(component, { runId: run.id })
        describedComponents.push({ ...component, description, aliases })
      } catch {
        // A single component's description failing shouldn't fail the whole
        // run — triage just sees "(no description yet)" for that one (see
        // triage.ts's own fallback for an empty description).
        describedComponents.push(component)
      }
    }

    const knownComponents = describedComponents.map((c) => c.name)
    const candidates = shortlistCandidates(rawCandidates, knownComponents)

    const triageResults = await triageCandidates(candidates, describedComponents, { runId: run.id })
    const candidatesById = new Map<string, ShortlistedCandidate>(candidates.map((c) => [c.id, c]))
    const componentsByName = new Map(describedComponents.map((c) => [c.name, c]))

    // Null (no verify) when NEBIUS_API_KEY/NEBIUS_PROJECT_ID aren't set — every
    // DRIFT finding then keeps `verdict: null`, same honest "not yet verified"
    // state this orchestrator has always used, just now also the state for
    // "verify isn't configured" rather than "verify isn't wired in at all."
    const sandbox = createSandboxClientFromEnv()
    const verifier = sandbox ? new RunVerifier(sandbox, input.repoRoot, input.dsPath) : null

    let drifts = 0

    for (const triage of triageResults) {
      if (!triage.match) continue
      const candidate = candidatesById.get(triage.id)
      const matchedComponent = componentsByName.get(triage.match)
      if (!candidate || !matchedComponent) continue

      const relFile = path.relative(input.repoRoot, candidate.file).replace(/\\/g, "/")
      const sourceFile = project.getSourceFileOrThrow(candidate.file)

      const base: NewFinding = {
        runId: run.id,
        file: relFile,
        line: candidate.line,
        endLine: candidate.endLine,
        fingerprint: candidate.fingerprint,
        matchedComponent: triage.match,
        triageConfidence: triage.confidence,
        originalSource: candidate.sourceText,
      }

      try {
        const adjudication = await adjudicateCandidate(
          {
            candidateId: candidate.id,
            candidateSource: candidate.sourceText,
            surroundingSource: sourceFile.getFullText(),
            matchedComponent,
          },
          { runId: run.id }
        )

        if (adjudication.classification !== "DRIFT") {
          await db.insert(findings).values({
            ...base,
            classification: adjudication.classification,
            rationale: adjudication.rationale,
            propMapping: adjudication.propMapping,
            unmappable: adjudication.unmappable,
            risk: adjudication.risk,
          })
          continue
        }

        drifts++
        const existingImports = sourceFile.getImportDeclarations().map((d) => d.getText())
        const migration = await migrateCandidate(
          {
            candidateId: candidate.id,
            candidateSource: candidate.sourceText,
            matchedComponent,
            existingImports,
            propMapping: adjudication.propMapping,
          },
          { runId: run.id }
        )

        let verifyFields: Partial<NewFinding> = {}
        if (verifier) {
          try {
            const afterWrapper = wrapAsStandaloneComponent(migration.replacementJsx, migration.importsToAdd)
            const typecheck = typecheckWrapper(project, input.repoRoot, afterWrapper)
            const verifyResult = await verifier.verifyCandidate({
              beforeJsx: candidate.sourceText,
              afterJsx: migration.replacementJsx,
              importsToAdd: migration.importsToAdd,
              typecheckPassed: typecheck.passed,
            })
            verifyFields = verifyResultToFindingFields(verifyResult)
            if (!typecheck.passed) {
              // Without this, a typecheck-driven FAIL is indistinguishable
              // from a pixel-driven one in the DB — migration.importsToAdd
              // isn't persisted anywhere else, so this is the only place the
              // actual diagnostic (and the exact wrapper checked) survives.
              verifyFields.verifyLog = `typecheck failed:\n${typecheck.messages.join("\n")}\n\n--- wrapper checked ---\n${afterWrapper}\n\n${verifyFields.verifyLog ?? ""}`
            }
          } catch (err) {
            // A verify failure is informative, not fatal — the finding still
            // gets its classification/migration; it just keeps
            // `verdict: null` instead of a real PASS/REVIEW/FAIL/UNVERIFIABLE,
            // logged into verifyLog so it's visible without failing the run.
            verifyFields = { verifyLog: `verify error: ${err instanceof Error ? err.message : String(err)}` }
          }
        }

        await db.insert(findings).values({
          ...base,
          classification: adjudication.classification,
          rationale: adjudication.rationale,
          propMapping: adjudication.propMapping,
          unmappable: adjudication.unmappable,
          risk: adjudication.risk,
          patchedSource: migration.replacementJsx,
          importsToAdd: migration.importsToAdd,
          ...verifyFields,
        })
      } catch (err) {
        // One candidate's pipeline failure shouldn't take down the whole run —
        // persist what we know (fingerprint, source) with no classification,
        // which the UI can render as "this one errored," not silently drop it.
        await db.insert(findings).values({
          ...base,
          rationale: `pipeline error: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    const fileLoc: Record<string, number> = {}
    for (const sourceFile of project.getSourceFiles()) {
      const rel = path.relative(input.repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
      fileLoc[rel] = sourceFile.getEndLineNumber()
    }

    await db
      .update(runs)
      .set({
        status: "completed",
        finishedAt: new Date(),
        stats: {
          filesScanned: project.getSourceFiles().length,
          candidates: candidates.length,
          filtered: rawCandidates.length - candidates.length,
          triaged: triageResults.length,
          drifts,
          fileLoc,
        },
      })
      .where(eq(runs.id, run.id))
  } catch (err) {
    console.error(`run ${run.id} failed:`, err)
    await db
      .update(runs)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(runs.id, run.id))
  } finally {
    // Reset to the default sink so a subsequent run (or any other agent call
    // in this process) doesn't accidentally write to a finished run's rows.
    setUsageSink(new JsonlUsageSink())
  }
}

/** Convenience for callers that want to await the whole run (CLI scripts, tests) — API routes should use createRun + executeRun separately instead, see their own docs above. */
export async function runPipeline(input: RunPipelineInput): Promise<{ runId: string }> {
  const run = await createRun(input)
  await executeRun(run, input)
  return { runId: run.id }
}

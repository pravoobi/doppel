# Doppel

Design-system drift agent. Finds the places a codebase re-implements a design-system component
by hand, migrates them, and proves the migration is safe by rendering it — not by hoping an LLM
got it right.

Built for the **Nebius x NVIDIA Global AI Hackathon** (Track: Coding and Agentic Engineering).
Runs on **Nebius Token Factory**, uses **NVIDIA Nemotron** models, verifies every patch in a
**Token Factory Sandbox**. Full spec and rationale: [`CLAUDE.md`](./CLAUDE.md).

## Status

**M1 complete.** The deterministic scanner (`packages/scanner`) indexes a design system and
extracts drift candidates with zero network calls and zero model calls — pure AST analysis via
ts-morph. Measured against the ground-truth fixture in `fixtures/drift-demo/`:

- **100% recall** — all 18 planted cases detected (15 true drifts, 3 adversarial traps)
- **100% precision** — every shortlisted candidate corresponds to a real planted case, 0 false
  positives, 0 flagged negatives
- 68 raw candidates extracted, 18 survived the deterministic shortlist (50 filtered before any
  model would see them — this ratio is the credit-efficiency argument in §7 of `CLAUDE.md`)

Gate target was ≥80% precision at 100% recall (`CLAUDE.md` §10, M1). See
[`docs/DECISIONS.md`](./docs/DECISIONS.md) for the two shortlist-rule refinements the fixture's
traps forced, and the one extraction-level exception (dialog/overlay roots are atomic).

**M2 complete.** `packages/agent` implements the full triage → adjudicate → migrate loop through a
single router (`route.ts`, CLAUDE.md §0.4) with zod-validated structured outputs, versioned prompts,
and per-call usage logging. Proven end-to-end against the fixture in `scripts/m2-pipeline.ts` —
real Nemotron calls, real ts-morph patch application, real `tsc --noEmit` diagnostics:

- **15/15 DRIFT-classified candidates passed typecheck** on the fixture (gate target: ≥10, per
  CLAUDE.md §10) — zero repairs needed
- 18/18 candidates survived triage; classification against `EXPECTED.json` was correct across all
  traps (marketing hero → `INTENTIONAL_DEVIATION`, layout wrapper → `NOT_DRIFT`)
- Getting here took real debugging, documented in full in `docs/DECISIONS.md`: a ts-morph API
  fragility, two import-handling bugs, a JSX pre-splice validator, and — the actual root cause of
  most failures — the model being unreliable at escaping double quotes inside a JSON string
  containing JSX. Single quotes in generated JSX attributes sidestep it entirely; also logged as
  concrete Nebius/NVIDIA feedback in `docs/FEEDBACK.md`.

**M3 complete.** `packages/verifier` implements the full harness → sandbox → shoot → diff → verdict
loop and it's been proven live, end-to-end, against a real M2 migration (`scripts/m3-pipeline.ts`):

- **A real, honest `REVIEW` verdict with 9 real PNG artifacts** (before/after/diff × 3 viewports)
  for the "Export CSV" button migration — deltaRatios of 1.06% / 0.52% / 0.28%, all correctly in
  the REVIEW band (gate target per CLAUDE.md §10: any real verdict with image artifacts)
- The verdict is *right*, not just present: the hand-rolled button used hardcoded `bg-blue-600`;
  the migrated `<Button>` correctly uses the design system's default variant — a real color
  difference a human should see, not a bug. This is CLAUDE.md §2.1's four-verdict design working
  as intended, proven against a real migration instead of asserted in the abstract.
- §3.3's "fork per patch from a warm base" is implemented literally: setup (npm install +
  Playwright/Chromium) runs once, then the same checkpoint forks twice — once per variant — using
  sandbox image-chaining confirmed live and unit-tested
- Added a real Tailwind build to `fixtures/drift-demo` (previously scan/typecheck-only, never
  rendered) so screenshots are visually meaningful, not unstyled HTML
- Four real bugs found and fixed via 6 live runs: a wrong base-image tag, a Playwright API misuse
  (`waitForFunction`'s argument order), Chromium blocking ES module scripts loaded over `file://`
  (fixed with a local HTTP server), and — the big one — large sandbox stdout silently switching to
  base64 encoding with no documented signal, which `sandbox.ts` was ignoring entirely. Full
  writeup in `docs/DECISIONS.md`; both infra surprises logged as concrete Nebius feedback.

**M4 complete.** `@doppel/db` (Drizzle schema for `runs`/`findings`/`llm_calls`, matching
CLAUDE.md §6 exactly) and a real orchestrator (`apps/web/lib/pipeline.ts`) tying
scanner → agent → verifier together and persisting results now exist. `apps/web` (Next.js 16, App
Router, Tailwind v4, shadcn/ui) has a run-history home page and a run-detail page with a drift map
(files sized by LOC, coloured by drift density, click-through to findings — §9), **verdict**-filter
tabs (§9: default to PASS, counts on every tab), stats, a cost panel (`/runs/[runId]/cost` —
calls/tokens/spend by tier and stage, the all-Ultra counterfactual, §7), and honest empty/error
states — verified against a real Neon Postgres database and a real browser, not just typechecked.

Verify (M3) is now wired into the live orchestrator: it builds **one** warm sandbox image per run
(dependencies installed once, per CLAUDE.md §3.3's "fork per patch from a warm base") and every
DRIFT candidate forks it for a real render, pixel-diff, and an in-memory `tsc` typecheck. Proven
live end to end against the real fixture: 18 candidates → 15 real migrations → all 15 through live
verify, landing real, differentiated `PASS`/`REVIEW`/`FAIL`/`UNVERIFIABLE` verdicts with real
before/after/diff screenshots (stored as inline `data:` URLs — no blob storage exists yet, and none
was needed). Scope cut, stated plainly in the code: isolation renders each candidate's own extracted
JSX standalone, not its whole containing page, so a candidate referencing its enclosing scope (a
local handler, mapped list item, component state) can't compile standalone — this surfaces
honestly today as `FAIL` (or `UNVERIFIABLE` when it can't render at all), not a silent guess. See
`docs/DECISIONS.md`'s 2026-09-24 entries for the full account, including two real sandbox-command
bugs found and fixed via a live smoke test before trusting this in a full run.

§9's last piece, PR export (`@doppel/github`), is built, unit-tested (32 tests, mocked GitHub API —
plain `fetch`, no octokit), and **proven against a real GitHub repo**: `POST /api/runs/[runId]/pr`
applies every `PASS` finding as a real file edit (patch + merged imports) grouped into one commit
per DS component, commits screenshots alongside so the PR body can link real URLs instead of
exceeding GitHub's 65536-character body limit, and opens the PR. A live run against a real
`drift-demo` repo produced a real PR with a correct patch, real committed screenshots, and a
correctly-formatted verdict table. One real gap found and fixed doing this: fine-grained GitHub
PATs need explicit `Contents: Read and write` permission for branch creation (`POST /git/refs`) —
the default/narrower grant fails with a `403` that reads like a code bug but isn't one. Set
`GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` (see `.env.example`) to use it; without
them the button fails with a clear setup message instead of a silent no-op.

**M5 in progress.** Dogfooding done (CLAUDE.md §8): ran Doppel on its own `apps/web`. 15 files
scanned, 4 candidates survived the shortlist, **2 real `DRIFT` findings in the dashboard's own
code** — `components/finding-card.tsx`'s "can't be mapped cleanly" notice and the cost panel's
pricing disclaimer are each a hand-rolled `<div>` independently reproducing `Card`'s exact styling,
correctly classified with real adjudicator rationale. Verify correctly declined to render either
(`apps/web` is Tailwind v4 with no `tailwind.config.ts`; the verify harness is tuned to the
fixture's Tailwind v3 setup — a stated scope boundary, not a bug) rather than guessing.

Repo is public: [github.com/pravoobi/doppel](https://github.com/pravoobi/doppel). **Live demo:**
[doppel-web-eight.vercel.app](https://doppel-web-eight.vercel.app/) — real pre-computed runs
visible immediately, no API key needed. One real deploy-only bug found and fixed getting there: the
cost panel 500'd in production because `config/pricing.json` is read via a computed `fs` path, which
Next.js's file-tracing can't see (only static imports get traced into the deployed bundle) — fixed
via `outputFileTracingIncludes` in `next.config.ts`, verified against a real local production build
before pushing. Remaining for M5: the submission video and finishing `docs/FEEDBACK.md`.

## Where Nebius / NVIDIA tooling is used

Per the submission requirements — concretely, not just "we used the sponsor's stuff":

- **NVIDIA Nemotron, three tiers, routed by task** (`packages/agent/src/route.ts` is the single
  call site, CLAUDE.md §0.4): **Nano** batch-classifies triage candidates and writes one-line DS
  component descriptions; **Super** adjudicates DRIFT/INTENTIONAL_DEVIATION/NOT_DRIFT with full
  source context; **Ultra** is reserved for migration authoring and repair — the two tasks that are
  genuinely generative, never called in a per-candidate loop for anything cheaper. The cost panel
  (`/runs/[runId]/cost`) makes this real, not asserted: a live run cost $0.13 actual vs. $0.27 if
  every call had gone to Ultra instead — a measured 50.6% saved by routing, not a claimed one.
- **Nebius Token Factory** is the sole inference backend — the OpenAI-compatible API with `baseURL`
  overridden, no other model provider anywhere in the codebase.
- **Token Factory Sandboxes** are the verification engine, which is the literal point of this
  project: every `DRIFT` migration gets rendered — original and patched — inside a real sandbox,
  screenshotted, and pixel-diffed, before a verdict is ever shown. One warm sandbox image per run
  (dependencies installed once) is forked per candidate rather than paying `npm install` cost per
  verification — CLAUDE.md §3.3's "fork per patch from a warm base," implemented literally using
  Sandboxes' image-checkpoint chaining. **Doppel never proposes a patch it hasn't rendered** — every
  `PASS`/`REVIEW`/`FAIL`/`UNVERIFIABLE` verdict in this project came from an actual sandbox render,
  not a model's opinion about whether code "looks right."
- Sandboxes accelerated the workflow specifically by making the render-and-diff loop **safe to run
  untrusted, model-generated JSX** without touching the host machine — the harness renders whatever
  Ultra just wrote, in an isolated, disposable environment, every time.

Concrete Nebius/NVIDIA feedback (API quirks, undocumented behavior, things that cost real debugging
time) is tracked continuously in [`docs/FEEDBACK.md`](./docs/FEEDBACK.md), not written the night
before submission.

## Repo layout

```
doppel/
├── apps/
│   └── web/        Next.js dashboard — run history, run detail, shadcn/ui
├── packages/
│   ├── shared/     types + pricing shared across the pipeline
│   ├── scanner/    the deterministic pipeline: index-ds, extract, fingerprint, shortlist
│   ├── agent/      model routing: route.ts, triage/adjudicate/migrate/repair/props-synthesis
│   ├── verifier/   harness generation, pixel diffing, verdict logic, sandbox client (all live-verified)
│   ├── db/         Drizzle schema + Neon client for runs/findings/llm_calls
│   └── github/     PR export: patch application, PR body, GitHub REST client (unit-tested, not live-tested)
├── fixtures/
│   └── drift-demo/  ground-truth fixture: an app with 18 planted drift cases + EXPECTED.json
├── config/
│   └── pricing.json Nemotron pricing, confirmed 2026-09-25 against the real Nebius dashboard
├── docs/
│   ├── DECISIONS.md decision log — read this for the "why" behind every non-obvious choice
│   └── FEEDBACK.md  running Nebius/NVIDIA tooling feedback
└── scripts/
    ├── spike.ts       day-one API/sandbox spike
    ├── m2-pipeline.ts live end-to-end proof of the M2 gate against the fixture
    └── m3-pipeline.ts live end-to-end proof of the M3 gate against the fixture
```

## Setup

```bash
pnpm install
pnpm test        # scanner/agent/verifier/shared/db/github test suites — 121 tests, zero network calls
pnpm typecheck
pnpm --filter @doppel/scanner cli -- --root fixtures/drift-demo --ds components/ui
pnpm --filter @doppel/web dev  # dashboard at localhost:3000 — needs DATABASE_URL for run history

# Requires NEBIUS_API_KEY (+ NEBIUS_PROJECT_ID for sandbox scripts) in .env — see .env.example.
# All three make real, billed API calls.
pnpm spike          # day-one model/sandbox spike
pnpm m2-pipeline     # full triage→adjudicate→migrate run against the fixture
pnpm m3-pipeline     # full harness→sandbox→shoot→diff→verdict run against the fixture
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).

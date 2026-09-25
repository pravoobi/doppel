# Doppel — Design-System Drift Agent

> Find the places a codebase re-implements a design-system component by hand, migrate them,
> and **prove the migration is safe by rendering it** — not by hoping the model got it right.

Hackathon: **Nebius x NVIDIA Global AI Hackathon** (Devpost)
Track: **Coding and Agentic Engineering**
Deadline: **Oct 30, 2026, 22:30 IST**
Working name: `doppel` (rename freely; it just needs to be consistent across repo / demo / video)

---

## 0. Read this first (instructions for Claude Code)

1. This file is the contract. If you're about to do something that contradicts a **Non-goal**
   in §12 or a **Gate** in §10, stop and say so instead of building it.
2. Ship in milestone order. Each milestone has an explicit gate. **Do not start milestone N+1
   until milestone N's gate passes.** A half-built verification loop with a beautiful dashboard
   loses to a rough dashboard with a working verification loop.
3. Never invent a Nebius model ID, endpoint, or SDK method. §3.1 says what's confirmed and what
   must be resolved by running `GET /v1/models` on day one. If something in this spec disagrees
   with the live API, the live API wins — update this file and note it in `docs/DECISIONS.md`.
4. Every LLM call goes through the single router in `packages/agent/src/route.ts`. No exceptions,
   no ad-hoc `openai.chat.completions.create` anywhere else in the codebase. That choke point is
   what makes the cost telemetry in §7 possible, and cost telemetry is a scored feature.
5. Prefer deleting scope over missing the gate date. See §11 (Risks) for what's pre-authorised
   to cut.

---

## 1. The problem

Design systems don't fail at adoption. They fail at **entropy**.

A team ships a component library. For six months everyone uses it. Then a deadline hits and
someone hand-rolls a `<button className="...">` because the library's Button didn't have the
exact variant they needed. Then someone copies that button. Then a contractor who never read
the docs builds three more. Two years later the library has a Button and the app has forty-one
other buttons, and nobody can tell you where they are.

This costs real money in three ways:

- **Design debt.** A rebrand or a token change updates the library and misses the forty-one.
- **Accessibility debt.** The library's Button handles focus rings, `aria-disabled`, keyboard
  activation on `<div role="button">`. Hand-rolled copies usually don't. In regulated frontends
  (banking, healthcare, anything in EAA/ADA scope) this is the single most common source of
  audit findings.
- **Velocity debt.** Every hand-rolled component is a thing that must be separately maintained,
  separately tested, separately reviewed.

Existing tooling doesn't solve this. ESLint can ban a raw `<button>` but can't tell you *which*
library component should replace it or how the props map. Design-token linters check colors, not
structure. Codemods handle known-shape mechanical renames, not "this bespoke div soup is
semantically a Card."

The reason nobody has automated it: the detection needs semantic judgment, and the migration
needs to be **trustworthy enough to merge**. An LLM can do the first part. Only a
render-and-compare loop can do the second.

**Target user.** A frontend lead or design-system maintainer at a company with 5+ product teams
on a shared component library. Concretely: the person who owns `@company/ui` and has no idea how
much of the org actually uses it.

---

## 2. What Doppel does (the loop)

```
repo URL
   │
   ├─▶ 1. INDEX      parse the design system → component capability index
   │
   ├─▶ 2. EXTRACT    walk the app's JSX → drift candidates + structural fingerprints
   │                 (deterministic, zero LLM calls)
   │
   ├─▶ 3. TRIAGE     Nemotron Nano, batched: "does this duplicate a DS component?"
   │
   ├─▶ 4. ADJUDICATE Nemotron Super: DRIFT / INTENTIONAL_DEVIATION / NOT_DRIFT
   │
   ├─▶ 5. MIGRATE    Nemotron Ultra: write the replacement JSX + prop mapping
   │
   ├─▶ 6. VERIFY     Token Factory Sandbox: render before & after, screenshot,
   │                 pixel-diff, typecheck, lint  →  PASS / REVIEW / FAIL / UNVERIFIABLE
   │                 (one Ultra repair attempt on FAIL, then drop)
   │
   └─▶ 7. REPORT     dashboard: drift map, finding cards with visual proof,
                     cost breakdown by model tier, "Open PR" for PASS patches
```

The thing that makes this a project and not a prompt is step 6. **Doppel never proposes a patch
it hasn't rendered.** Say that sentence in the demo video.

### 2.1 The four verdicts

`INTENTIONAL_DEVIATION` and `UNVERIFIABLE` are not failure states to hide — they are the two
verdicts that prove the tool understands its own domain. Surface both prominently in the UI.

| Verdict | Meaning | UI treatment |
|---|---|---|
| `PASS` | Renders identically (≤0.5% pixel delta at all viewports), typechecks, lints | Green. Included in PR export. |
| `REVIEW` | Renders with visible but plausible difference (0.5–5%) | Amber. Side-by-side images, human decides. Excluded from PR by default. |
| `FAIL` | Typecheck/lint error, or >5% visual delta, after one repair attempt | Red. Shown with the compiler error. Never exported. |
| `UNVERIFIABLE` | Component could not be rendered in isolation (needs router/auth/data context) | Grey. Patch shown as a *suggestion only*, clearly labelled unproven. |
| `INTENTIONAL_DEVIATION` | Adjudicator decided this deliberately differs (marketing hero, one-off illustration) | Blue. No patch generated. Counted separately in the drift score. |

---

## 3. Platform: Nebius Token Factory

### 3.1 Confirmed vs. must-verify

**Confirmed (as of research on 2026-09-22):**

- Base URL: `https://api.tokenfactory.nebius.com/v1/`
- Auth: bearer token from env `NEBIUS_API_KEY`
- The inference API is **OpenAI-compatible** — use the official `openai` npm package with
  `baseURL` overridden. Do not write a bespoke HTTP client.
- Sandboxes are branded **ConTree**. Python SDK: `pip install contree-sdk contree-client`.
  There is also a CLI (`contree-mcp --mode http --http-port 9452` runs an MCP server) and a
  REST API documented at `docs.tokenfactory.nebius.com/api-reference/sandboxes`.
  Sandboxes support **OCI images** (Docker Hub / GHCR) and git-style branch/fork/rollback.
  Beta limit: **50 simultaneous operations.**
- Model ID confirmed from two independent sources: `nvidia/nemotron-3-super-120b-a12b`

**Must verify on day one — do this before writing any agent code:**

```bash
curl -s https://api.tokenfactory.nebius.com/v1/models \
  -H "Authorization: Bearer $NEBIUS_API_KEY" | jq -r '.data[].id' | grep -i nemotron
```

Write the result verbatim into `packages/agent/src/models.ts` and never hardcode a model ID
anywhere else. Expected family (IDs below are **best-known guesses, not confirmed** — the curl
output is the source of truth):

| Tier | Likely ID | Params | Context | Indicative price in/out per 1M |
|---|---|---|---|---|
| Nano / Lightning | `nvidia/Nemotron-3_5-Lightning` or a `nemotron-3-nano-30b*` id | 30B MoE | ~1M | $0.06 / $0.24 |
| Super | `nvidia/nemotron-3-super-120b-a12b` | 120B, 12B active | 262K–1M | $0.30 / $0.90 |
| Ultra | `nvidia/Nemotron-3-Ultra-550b-a55b` | 550B, 55B active | ~1M | $1.00 / $3.00 |

Prices are indicative from a third-party model directory. Pull real numbers from the Token
Factory pricing page into `config/pricing.json` — the cost panel (§7) must not show made-up
figures to a panel of Nebius employees.

### 3.2 Day-one spike (do this the hour credits arrive)

Create `scripts/spike.ts` that proves all three legs work, and nothing else:

1. `GET /v1/models` → print every Nemotron ID.
2. One chat completion against each tier with a 20-token prompt → print latency + usage.
3. One sandbox: pull `ubuntu:latest`, run `echo hello`, print stdout/exit code.
4. **In the same sandbox**, run `npm --version` and `curl -sI https://registry.npmjs.org`.

Step 4 is the important one. **If sandboxes have no outbound network access, the entire
architecture changes**: you cannot `pnpm install` at verify time and must bake every dependency
into a custom OCI image. Find this out on day one, not in week three. Record the answer in
`docs/DECISIONS.md`.

### 3.3 Sandbox runtime strategy

Cold-starting a sandbox and running `pnpm install` + `playwright install` per verification is
far too slow — you'd burn the whole verification budget on npm. Instead:

1. Build **one** custom image: `node:22-slim` + pnpm + Playwright + Chromium + the fixture repo's
   `node_modules` pre-installed. Push to GHCR once.
2. Every verification forks from that image. Use ConTree's branching so each patch gets an
   isolated fork of the same warm base, and roll back instead of tearing down.
3. Cap concurrency at **8** (well under the beta limit of 50, leaves headroom for retries).

For repos other than the fixture, fall back to clone + install inside the sandbox and accept
that it's slow. Those runs are for the "it generalises" claim in the video, not the live demo.

### 3.4 Serverless Jobs (optional, bonus points)

The brief explicitly encourages **Nebius Serverless Jobs** for background/async work. A repo scan
is exactly that. If M3 lands on time, move the scan worker to Serverless Jobs and say so in the
README and the video — it's a cheap point on Technological Implementation. If time is short, a
Postgres-backed job table with a polling Node worker is fine. **Do not** build this before M3.

---

## 4. Architecture

```
doppel/
├── apps/
│   └── web/                  Next.js 15 (App Router) — dashboard + API routes + worker entry
│       ├── app/
│       │   ├── page.tsx                     repo input, run history
│       │   ├── runs/[runId]/page.tsx        drift map + finding list
│       │   ├── runs/[runId]/cost/page.tsx   model-tier cost panel
│       │   └── api/
│       │       ├── runs/route.ts            POST: start a run
│       │       └── runs/[id]/stream/route.ts SSE: live progress
│       └── components/       built with shadcn/ui  ← we dogfood our own subject matter
│
├── packages/
│   ├── scanner/              PURE, DETERMINISTIC, NO LLM. The part that must be excellent.
│   │   ├── src/index-ds.ts          build design-system capability index (ts-morph)
│   │   ├── src/extract.ts           walk JSX → candidates
│   │   ├── src/fingerprint.ts       structural fingerprint
│   │   ├── src/shortlist.ts         rule-based candidate → DS component shortlist
│   │   └── test/                    Vitest, golden files against fixtures
│   │
│   ├── agent/                all model interaction
│   │   ├── src/models.ts            model IDs pinned from GET /v1/models
│   │   ├── src/route.ts             THE single call site. tier selection, retry, usage logging
│   │   ├── src/triage.ts            Nano, batched
│   │   ├── src/adjudicate.ts        Super
│   │   ├── src/migrate.ts           Ultra
│   │   ├── src/repair.ts            Ultra, given a compiler error
│   │   ├── src/schemas.ts           zod schemas for every structured output
│   │   └── prompts/*.md             versioned prompt templates, loaded at runtime
│   │
│   ├── verifier/             sandbox orchestration + harness generation + image diff
│   │   ├── src/sandbox.ts           ConTree client wrapper
│   │   ├── src/harness.ts           generate the isolation render harness
│   │   ├── src/shoot.ts             Playwright screenshots at 3 viewports
│   │   └── src/diff.ts              pixelmatch, threshold rules
│   │
│   └── shared/               types, db schema (Drizzle), constants
│
├── fixtures/
│   └── drift-demo/           seeded Next.js + shadcn/ui app with ~18 planted drifts
│
├── docs/
│   ├── DECISIONS.md          running log — especially §3.2 spike answers
│   └── FEEDBACK.md           Nebius/NVIDIA feedback, drafted as you go (see §14)
│
└── scripts/spike.ts
```

**Language split.** Everything is TypeScript. **DECIDED 2026-09-23**: the Sandboxes REST API works
directly from Node via plain `fetch` — no Python/`contree-sdk` service needed. One real gap the
REST reference docs don't cover: spawning is asynchronous (`POST /instances` returns `result: null`
immediately) and the result only shows up later via `GET /operations/{uuid}` — a polling
relationship the fetchable API docs never state, found empirically. `packages/verifier/src/
sandbox.ts` implements `whoami`/`spawnInstance`/`pollOperation`/`runCommand` against this, verified
live. One runtime, one deploy, as hoped — do not build a Python `services/verifier/` fallback.

**Datastore.** Postgres (Neon free tier) + Drizzle. Schema in §6.

---

## 5. The pipeline in detail

### 5.1 Index the design system (deterministic + one cheap Nano pass)

Locate the design system by, in order: an explicit `--ds` path flag; an in-repo `components/ui/`
directory (shadcn convention); a dependency matching a known list (`@mui/material`,
`@chakra-ui/react`, `antd`, `@radix-ui/*`).

For each exported component, use **ts-morph** to extract:

```ts
type DsComponent = {
  name: string                  // "Button"
  importPath: string            // "@/components/ui/button"
  props: PropSpec[]             // name, type, optional, union literals
  variants: Record<string,string[]>  // { variant: ["default","destructive"], size: [...] }
  sourceExcerpt: string         // first ~80 lines, for the adjudicator's context
  description: string           // ← Nano writes this
  aliases: string[]             // ← Nano writes this: ["banner","callout","notice"]
}
```

Only `description` and `aliases` need a model, one Nano call per component (~30–60 calls total,
negligible cost). Everything else is AST work — keep it that way.

### 5.2 Extract candidates (deterministic, zero LLM)

Walk every `.tsx` under the app source roots. **Exclude** the design-system directory itself,
`*.test.tsx`, `*.stories.tsx`, and `node_modules`.

A **candidate** is a JSX subtree rooted at a host element (lowercase tag) or a local
`styled`/`cva` component, which satisfies at least one signal:

- `className` containing ≥3 utility tokens, or any inline `style`
- an interaction handler (`onClick`, `onKeyDown`, …)
- `role=` or any `aria-*` attribute
- a subtree of ≥2 element nodes

Fingerprint each one:

```ts
type Fingerprint = {
  rootTag: string
  depth: number
  childTags: string[]
  classTokens: string[]       // normalised: bg-*, rounded-*, px-*, text-*
  ariaRole: string | null
  hasHandler: boolean
  textSample: string          // first 40 chars of literal text, for context
  file: string; line: number
}
```

**Precision is the whole game here.** A tool that flags every `<div>` is noise and judges will
see through it instantly. Track precision against the fixture repo in a Vitest golden test and
keep it above 80% before you let a single candidate reach a model.

### 5.3 Shortlist (deterministic rules)

Map fingerprints to 1–3 plausible DS components using hand-written rules. This is the credit-
efficiency lever: it cuts the LLM call volume by an order of magnitude.

| Signal | Shortlist |
|---|---|
| `<button>`, or `role="button"`, or handler + `cursor-pointer` | Button |
| `rounded-*` + `border` + `p-*` wrapper containing a heading | Card |
| `bg-{red,amber,green}-*` + icon child + text | Alert |
| `<input>`/`<textarea>` with a sibling `<label>` | Input, Field |
| small pill: `text-xs` + `rounded-full` + `px-2` | Badge |
| `fixed inset-0` + `z-*` overlay | Dialog, Sheet |
| `<table>` with `<thead>` | Table, DataTable |

Candidates with an empty shortlist are dropped without a model call. Log how many — that number
goes in the cost panel as "filtered before inference."

### 5.4 Triage — Nemotron **Nano**, batched

Input: 20 fingerprints + the shortlisted components' one-line descriptions.
Output (zod-validated, one object per candidate):

```ts
{ id: string, match: string | null, confidence: number, reason: string }
```

Batching 20 per call matters — per-call overhead dominates at this volume. Drop anything with
`confidence < 0.4`.

### 5.5 Adjudicate — Nemotron **Super**

Input: the candidate's **full source**, its surrounding component, and the matched DS
component's props + source excerpt.

Output:

```ts
{
  classification: 'DRIFT' | 'INTENTIONAL_DEVIATION' | 'NOT_DRIFT',
  rationale: string,
  propMapping: Array<{ from: string, to: string, note?: string }>,
  unmappable: string[],      // styles/behaviours the DS component can't express
  risk: 'low' | 'medium' | 'high'
}
```

The `unmappable` field is what makes this credible. If a hand-rolled button has a gradient the
DS Button has no variant for, the honest answer is "this is drift, but migrating it loses the
gradient — here's the tradeoff," not a silent visual regression. Surface `unmappable` on the
finding card.

Prompt must define `INTENTIONAL_DEVIATION` with examples: marketing/landing surfaces, one-off
illustrations, deliberate experiments behind a flag, anything with a `// doppel-ignore` comment.

### 5.6 Migrate — Nemotron **Ultra**

Only for `classification === 'DRIFT'`. Input: candidate source, DS component API, the file's
existing imports, the adjudicator's `propMapping`.

Output:

```ts
{ replacementJsx: string, importsToAdd: string[], notes: string, confidence: number }
```

Apply with **ts-morph node replacement, never string splicing** — you have the exact AST node
from extraction; use it. Then run Prettier with the repo's own config.

### 5.7 Verify — Token Factory Sandbox (the differentiator)

Per patch, inside a fork of the warm base image (§3.3):

1. **Generate an isolation harness.** A tiny Vite entry that imports the *containing component's
   file* and renders it twice — once from the original source, once patched — with synthesised
   props.
   - Prop synthesis: Ultra generates a props fixture from the component's TS signature plus its
     real call sites. **Cache per component** — this is the single most repeated Ultra call and
     caching it is worth real money.
   - Wrap in a configurable provider shim (ThemeProvider, a memory router, a mock query client).
     If it still won't mount → verdict `UNVERIFIABLE`, stop here, do not guess.
2. **Screenshot** both variants with Playwright at 375 / 768 / 1440 px, plus dark mode if the
   repo sets a `dark` class.
3. **Diff** with `pixelmatch`, anti-aliasing tolerance on, producing `deltaRatio` per viewport.
4. **Typecheck** `tsc --noEmit` and **lint** the patched file with the repo's ESLint config.
5. **Verdict** per the table in §2.1, using the worst result across viewports.
6. On `FAIL` from a compiler error: **one** Ultra repair attempt with the error text, then
   re-verify. Never loop more than once — that's how hackathon credit budgets evaporate.
7. Persist `before.png`, `after.png`, `diff.png` and the raw tool output.

**Plan B — decide by Oct 19, no debate.** If isolation rendering is still flaky at the M3 gate,
switch the verify step to: render with `jsdom` + `@testing-library/react`, snapshot the
**accessibility tree and normalised DOM structure**, and diff those instead of pixels. It is a
weaker proof but it is still "verified, not guessed," it runs in-process, and it will not eat
the remaining schedule. Losing the screenshots costs you some Design points; missing the deadline
costs you everything.

---

## 6. Data model (Drizzle / Postgres)

```ts
runs            id, repoUrl, ref, dsPath, status, startedAt, finishedAt,
                stats jsonb   // {filesScanned, candidates, filtered, triaged, drifts}

findings        id, runId, file, line, endLine,
                fingerprint jsonb,
                matchedComponent, triageConfidence,
                classification,          // DRIFT | INTENTIONAL_DEVIATION | NOT_DRIFT
                rationale, propMapping jsonb, unmappable jsonb, risk,
                originalSource text, patchedSource text,
                verdict,                 // PASS | REVIEW | FAIL | UNVERIFIABLE
                deltaRatio real, verifyLog text,
                beforeUrl, afterUrl, diffUrl

llm_calls       id, runId, findingId, stage, modelId, tier,
                promptTokens, completionTokens, latencyMs, costUsd
                // ← the cost panel is a GROUP BY over this table. Log every call.
```

---

## 7. Cost telemetry (a scored feature — build it, don't bolt it on)

The brief goes out of its way to talk about letting Nano/Super handle everyday calls "so your
credits stretch further," and Nebius product people are on the judging panel. Make the routing
visible.

`/runs/[runId]/cost` shows:

- Calls, tokens and spend **per stage and per tier**
- Candidates **filtered deterministically before any inference** (the shortlist win)
- A counterfactual: **what this run would have cost routed entirely to Ultra**, and the
  percentage saved
- Ultra calls as a share of total calls (should be low single digits — that's the point)

Expected shape on the fixture repo, roughly:

| Stage | Tier | Calls | Share of spend |
|---|---|---|---|
| DS descriptions | Nano | ~40 | <1% |
| Triage | Nano | ~60 batched (1,200 candidates) | ~5% |
| Adjudicate | Super | ~90 | ~25% |
| Migrate | Ultra | ~25 | ~50% |
| Prop synthesis (cached) | Ultra | ~12 | ~15% |
| Repair | Ultra | ~3 | ~5% |

Put this table in the README with **real measured numbers** once you have them.

---

## 8. The fixture repo (do not skip — the demo depends on it)

`fixtures/drift-demo/` is a small but believable Next.js + shadcn/ui admin dashboard with
**~18 planted drifts**, written the way a rushed developer actually writes them, not the way a
test fixture is usually written:

- 4 hand-rolled buttons (one with a gradient the DS Button can't express → tests `unmappable`)
- 3 card-shaped divs, one nested inside a real `Card` (tests over-eager matching)
- 2 alert banners, one with `role="alert"`, one without (the second is the a11y story)
- 2 badges, 2 inputs with detached labels, 1 modal overlay, 1 table
- **3 deliberate traps**: a marketing hero that *should* be classified
  `INTENTIONAL_DEVIATION`, a div that merely looks like a card but is a layout wrapper
  (`NOT_DRIFT`), and a component that cannot render in isolation (`UNVERIFIABLE`)

Maintain `fixtures/drift-demo/EXPECTED.json` as ground truth and assert against it in CI. This
is how you can honestly state a precision number in the README, and stating a real precision
number is worth more to judges than a bigger one you can't defend.

Also run against **one real OSS repo** using shadcn/ui for the generality claim in the video.

### Dogfooding

Once the dashboard exists, run Doppel **on Doppel's own `apps/web`**. Whatever it finds goes in
the video. "We ran it on ourselves and it found three" is the most persuasive thirty seconds you
can record, and it costs you nothing.

---

## 9. Dashboard (the Design criterion lives here)

Judges score "a complete, coherent product experience not just a technical proof of concept."
You are a senior frontend engineer competing against a field of ML people shipping Streamlit.
This is your edge — spend the polish budget here, not on more pipeline features.

- **Run view.** Drift map — files as a treemap sized by LOC, coloured by drift density. Click
  through to findings. Live progress over SSE while the run executes; a run that visibly streams
  reads as a product, a spinner reads as a script.
- **Finding card.** The centrepiece. Left: original source. Right: patched source. Below:
  before / after / diff screenshots in a three-up. Header: matched component, confidence,
  verdict badge, risk. Expandable: the adjudicator's rationale and `unmappable` list.
- **Verdict filters** across the top, with counts. Default to `PASS`; make `REVIEW` one click.
- **Cost panel.** §7.
- **Open PR.** Select `PASS` findings → create a branch, apply patches grouped by DS component,
  open a PR whose body embeds the before/after images and the verdict table. Requires
  `GITHUB_TOKEN`. This is the feature that makes it a tool rather than a report.
- **Empty and error states.** A scan that finds nothing should say something useful. Judges
  poke at edges.

Dark mode, keyboard navigation, and real focus management throughout — an accessibility-adjacent
tool with an inaccessible UI is an own goal a judge will enjoy pointing out.

---

## 10. Milestones and gates

Calendar reality this is built around: the Cloudinary submission is due **Oct 3**, the Amazon
Build/Ship/Shape submission is due **Oct 24**, and the new role starts **Oct 12, five days a week
onsite**. Oct 4–11 is the last stretch of genuinely open time. Front-load accordingly.

| # | Window | Work | Gate |
|---|---|---|---|
| **M0** | Sep 23–26 | Scaffold monorepo. `scripts/spike.ts`. *Runs the hour credits land.* | Model list printed, one completion per tier, sandbox `echo` works, **sandbox network access answered** (§3.2) |
| **M1** | Sep 27–Oct 3 | Fixture repo + `EXPECTED.json`. DS index, extraction, fingerprints, shortlist. **No LLM.** Low intensity — Cloudinary is finishing. | CLI prints ranked candidates on the fixture with **≥80% precision** against `EXPECTED.json` |
| **M2** | **Oct 4–11** | Triage → adjudicate → migrate. Structured outputs, zod, router, usage logging. **Use this window hard — it's the last free one.** | ≥10 patches generated that pass `tsc --noEmit` |
| **M3** | Oct 12–19 | Sandbox image, harness, screenshots, pixel diff, verdicts, repair loop. Evenings only. | End-to-end run yields PASS/REVIEW/FAIL/UNVERIFIABLE with image artifacts. **Not met by Oct 19 → Plan B (§5.7), immediately** |
| **M4** | Oct 20–25 | Dashboard, cost panel, PR export. ⚠️ Collides with the Amazon deadline (Oct 24) — see §11.3 | Full run viewable and navigable in the browser by a stranger |
| **M5** | Oct 26–29 | Dogfood run, README, Apache-2.0 licence, deploy, **3-min video**, Nebius feedback, submit. **Feature freeze Oct 27.** | Submitted by Oct 29 |
| — | Oct 30 | Buffer. Do not plan work here. | — |

The video is a judged artifact, not an afterthought. Two full days for it is correct, not
generous — the audio has to explain how you used Token Factory and Nemotron, and that narration
takes rewriting.

---

## 11. Risks

**11.1 Credits arrive late.** M1 needs no credits at all — it's pure AST work and it's the
biggest deterministic chunk. If credits slip a week, nothing is lost. Build in this order for
exactly this reason.

**11.2 Isolation rendering is flaky.** The known hard part. Arbitrary React components resist
rendering outside their app context. Mitigations: optimise the golden path on the fixture repo
you control; treat `UNVERIFIABLE` as a first-class honest verdict rather than a bug; hard-switch
to Plan B (§5.7) on Oct 19.

**11.3 The Amazon hackathon collides with M4.** Oct 24 and Oct 30 are eight days apart and M4 is
the dashboard — the highest-scoring milestone for a frontend engineer. **Decide by Oct 10**,
not Oct 22: either finish the Wardrobe MCP server by Oct 19 and give Doppel a clean run at M4/M5,
or descope Doppel now to Plan B verification plus a simpler dashboard. Two strong submissions
beat three thin ones; three thin ones beat nothing, but not by much.

**11.4 Sandbox cold start eats the budget.** Bake the custom OCI image once (§3.3). Cap
concurrency at 8. Measure per-verification wall time at M3 and, if it's over ~90s, cut the
viewport count from 3 to 1 before cutting anything else.

**11.5 False positives make it look naive.** Precision gate at M1 is non-negotiable. Show
confidence on every card. State the real measured precision in the README — a defensible 84%
reads as engineering maturity; an undefended "highly accurate" reads as a hackathon demo.

**11.6 Model IDs / API shape drift.** Pin from `GET /v1/models` on day one into
`packages/agent/src/models.ts`. Single source of truth.

**11.7 New-job onboarding eats the evenings.** M4 and M5 are the compressible ones. M1–M3 must
be done by Oct 19 or the project is in trouble — protect that date above all others.

---

## 12. Non-goals (say no to all of these)

- Any language but TypeScript/React/JSX. No Vue, Angular, Svelte, React Native.
- More than one design system at a time. Target **shadcn/ui** as primary. MUI only if M4 lands early.
- Auto-merging. Every patch is human-reviewed via PR. Say this out loud in the video — it's a
  trust feature, not a limitation.
- CSS-in-JS theme migration, design-token refactors, Figma integration.
- Auth, multi-tenancy, billing, teams. Single-user demo.
- A VS Code extension. Tempting, not scoreable here.
- Incremental/watch mode, git-history drift trends. Nice ideas, post-hackathon.

---

## 13. How this maps to the judging criteria

| Criterion | What earns the score |
|---|---|
| **Technological Implementation** | Three-tier Nemotron routing with a real cost argument; Token Factory **Sandboxes used for verification, which is the literal track prompt**; structured outputs under zod; deterministic prefiltering that cuts inference volume an order of magnitude; Serverless Jobs if M3 lands early |
| **Design** | A real dashboard, not a notebook. Visual proof on every finding. Live-streaming runs. PR export closes the loop. Built with shadcn/ui and dogfooded on itself |
| **Potential Impact** | Design-system entropy is a universal, expensive, unautomated enterprise problem. Ties directly to accessibility and brand-compliance exposure in regulated frontends — a domain you can speak to with authority |
| **Quality of the Idea** | Nobody builds frontend governance tooling at an AI hackathon. "Never propose a patch you haven't rendered" is a genuinely non-obvious use of a code sandbox. `INTENTIONAL_DEVIATION` and `UNVERIFIABLE` demonstrate understanding of the problem space that a naive build would skip |

---

## 14. Submission checklist (from the Devpost requirements)

- [ ] Track selected: **Coding and Agentic Engineering**
- [ ] Runs on **Nebius Token Factory**, uses **NVIDIA Nemotron** models — stated explicitly in the README
- [ ] Working demo URL (deployed dashboard with at least one pre-computed run visible **without
      requiring the judge to have an API key** — seed a demo run into the database)
- [ ] Public repo with an **OSS licence visible at the top of the repository page** (Apache-2.0)
- [ ] README with setup instructions **and** a section highlighting where Nemotron and Token
      Factory were used, and where Sandboxes accelerated the workflow
- [ ] **YouTube video, public, ≤3 minutes**, with audio covering Token Factory and Nemotron usage
- [ ] Project description: what, why, how it works
- [ ] **Feedback on Nebius Token Factory / NVIDIA tooling** — draft `docs/FEEDBACK.md` continuously
      as you build, don't write it at 10pm on Oct 29. There are ten $100 "Most Valuable Feedback"
      prizes and almost nobody writes this carefully
- [ ] Net-new project, so the "explain what was significantly updated during the Submission
      Period" clause does not apply. Keep it that way — **do not** graft this onto an existing
      repo of yours, or it triggers that disclosure and weakens the submission
- [ ] City Winner Award (20 × $500): the published Builders & Brews roster is North America and
      Europe only — Warsaw, Mexico City, New York, Amsterdam, Berlin, Toronto, Paris, Boston,
      San Francisco, Los Angeles, plus London and Seoul — with **no India event**. Treat this
      prize as unavailable unless an APJ event is announced; re-check once before submitting
- [ ] Not eligible for the $3,000 Tavily prize unless web search is genuinely used. Don't bolt it
      on. (A defensible angle if M4 lands early: Tavily-fetch the design system's public docs to
      enrich the capability index for libraries like MUI. Only if it's real.)

### Video script skeleton (3:00)

- 0:00–0:25 — The problem. Show the fixture app. "One Button in the library. Five in the app."
- 0:25–0:50 — Run it live. Streaming progress. The drift map filling in.
- 0:50–1:40 — One finding card end to end: matched component, rationale, patch, **and the
  before/after/diff screenshots**. "It didn't guess this was safe. It rendered it."
- 1:40–2:10 — Architecture: the three Nemotron tiers and why each call goes where it goes.
  Show the cost panel and the all-Ultra counterfactual.
- 2:10–2:35 — Sandboxes: forking a warm image per patch, typecheck, lint, pixel-diff.
- 2:35–2:50 — Dogfooding + the PR export.
- 2:50–3:00 — Impact: design-system entropy, accessibility exposure, who this is for.

---

## 15. Conventions

- TypeScript strict. No `any`. No non-null assertions without a comment saying why.
- **Every** model response is parsed through a zod schema. A parse failure is a retry with the
  validation error appended, then a hard failure — never a silent fallback to free-form text.
- Prompts live in `packages/agent/prompts/*.md` and are loaded at runtime, never inlined in code.
- Never call Ultra inside a loop over candidates. If you're about to, you've mis-tiered the stage.
- `packages/scanner` has no network dependency and no model dependency. It is unit-testable and
  unit-tested. Vitest, golden files against `fixtures/drift-demo`.
- Every LLM call writes a row to `llm_calls` before returning. No exceptions.
- Log decisions in `docs/DECISIONS.md` as you make them — it becomes the README's architecture
  section and half the video narration for free.

## 16. Environment

```bash
NEBIUS_API_KEY=            # Token Factory — Sandboxes use this SAME key, not a separate credential
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1/
SANDBOXES_BASE_URL=https://api.tokenfactory.nebius.com/sandboxes/v1
NEBIUS_PROJECT_ID=         # from tokenfactory.nebius.com/project/api-keys — required for spawn/list
DATABASE_URL=              # Neon
GITHUB_TOKEN=              # PR export only
DOPPEL_MAX_SANDBOX_CONCURRENCY=8
DOPPEL_PIXEL_PASS_THRESHOLD=0.005
DOPPEL_PIXEL_REVIEW_THRESHOLD=0.05
```

## 17. Open questions — resolve on day one, record in `docs/DECISIONS.md`

1. ~~Exact Nemotron model IDs, and whether a Nano tier is actually available~~ — **RESOLVED
   2026-09-23**: 4 distinct models confirmed live (Nano, Lightning, Super, Ultra), pinned in
   `packages/agent/src/models.ts`. See `docs/DECISIONS.md`.
2. ~~Is the Sandboxes REST API usable directly from Node~~ — **RESOLVED 2026-09-23**: yes, plain
   `fetch` against the REST API, no `contree-sdk` needed. `packages/verifier/src/sandbox.ts`.
3. ~~Do sandboxes have outbound network access?~~ — **RESOLVED 2026-09-23: YES.** `apt-get` and
   `curl` to an external HTTPS host both confirmed working inside a real sandbox. `pnpm install`
   at verify time is viable; dependencies do not have to be baked into the OCI image. See
   `docs/DECISIONS.md`.
4. Rate limits on Ultra — if concurrency is tight, the migrate stage needs a queue.
5. Real per-token pricing, into `config/pricing.json` — third-party-sourced and marked
   `confirmed: false` as of 2026-09-23; still needs verification against the real Nebius dashboard.
6. Whether the submission period start date has any bearing on the fixture repo's commit history
   (it shouldn't — everything here is net-new).

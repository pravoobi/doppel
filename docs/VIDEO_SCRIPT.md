# Submission video script (3:00)

Every claim and number below is real — pulled directly from this session's live runs, not
invented for the video. Timestamps are targets, not hard cuts; adjust pacing in editing.
Recording notes are in *italics*.

---

## 0:00–0:25 — The problem

**VOICEOVER:**
"Every design system starts clean. Six months in, someone needs a button the library doesn't
have a variant for, so they hand-roll one. Then someone copies it. Two years later the library
has one Button, and the app has forty-one others nobody can find.

This is Doppel. It finds those forty-one, migrates them, and proves each migration is safe by
actually rendering it — not by asking a model if the code 'looks right.'"

**ON SCREEN:** Open `fixtures/drift-demo` in an editor. Show `components/ui/button.tsx` (the one
real Button) side by side with a hand-rolled `<button className="...">` in `app/page.tsx`. Circle
or highlight both.

**ON-SCREEN TEXT:** "Doppel — find the drift, migrate it, prove it's safe by rendering it."
(title card, first 2–3 seconds, then fades)

*Recording note: this is the exact planted-drift fixture this project's own test suite validates
against — 18 planted cases, 100% recall / 100% precision measured, not asserted.*

---

## 0:25–0:50 — Run it live

**VOICEOVER:**
"Point it at a repo and it streams progress live — scan, triage, adjudicate, migrate, verify —
not a spinner, a real pipeline you can watch."

**ON SCREEN:** Load `localhost:3000` (local `next dev`/`next start` — same UI, same database as
the live demo), click "Start demo run." Show the run page auto-refreshing as findings populate —
stats grid filling in (Files scanned, Candidates, Filtered pre-inference, Triaged, Drifts), then
the drift map's colored boxes appearing.

**ON-SCREEN TEXT:** "68 candidates → 18 after deterministic filtering — before any model call."
(appears once the stats grid populates, timed to the "Filtered pre-inference" number landing)

*Recording note: record the live trigger against LOCAL, not the deployed Vercel URL — confirmed
this session that the full fixture's 15 real DRIFT candidates, run serially through
adjudicate→migrate→verify with no concurrency yet, take roughly 10–12 minutes end to end, well
past Vercel's 300s `maxDuration`. Local has no such ceiling, and because local and the deployed
app share the same database, this exact run shows up live at `doppel-web-eight.vercel.app`
immediately after — that's what the next two segments (finding card, cost panel) should actually
screen-record, so the "public demo" claim stays true without re-triggering anything on Vercel.
Record the trigger+wait live, then speed up the waiting portion 4–8x in editing (standard,
honest — you're not faking "live," you're compressing dead air). Real numbers to expect on the
fixture: 68 raw candidates, 18 survive the deterministic shortlist before any model sees them.*

---

## 0:50–1:40 — One finding, start to finish

**VOICEOVER:**
"Here's one: a hand-rolled alert banner in the billing page — a payment-failed warning, styled
red, written from scratch with its own color values. Nano flagged it as a candidate. Super
adjudicated it: real drift, not intentional — here's why, here's how it maps to the design
system's Alert component. Ultra wrote the migration.

Then it got rendered. Original on the left, patched on the right, before and after screenshots,
pixel-diffed. This one came back REVIEW — a 0.71% visual difference, because the hand-rolled
version hardcodes its own red shades and the real Alert's destructive variant uses the design
system's own reds instead. That's not a bug. That's the tool catching a real, visible difference —
and telling you exactly which classes it couldn't map cleanly — before a human merges it blind.

It didn't guess this was safe. It rendered it."

**ON SCREEN:** Cut to `doppel-web-eight.vercel.app` — the same run just triggered locally, now
live on the public demo. Click into the Alert finding on `app/billing/page.tsx` (line 17). Show:
matched component badge, confidence %, rationale text, original/patched source side by side, the
three real screenshot thumbnails (before/after/diff), the REVIEW verdict badge, and the "Can't be
mapped cleanly" callout listing the three hardcoded red classes.

**ON-SCREEN TEXT:** "Verdict: REVIEW — Δ 0.71% visual difference." (appears next to the
screenshot three-up, timed to when the diff image is on screen)

*Recording note: real finding from the latest local run (2026-10-29, run `2750c2b2...`) — a
hand-rolled `role="alert"` div vs. the real `Alert` component, `variant='destructive'`.
`unmappable`: `border-red-300`, `bg-red-50`, `text-red-900` — the Alert's destructive variant
uses the design system's own red tokens instead. Good showcase of the `unmappable` field CLAUDE.md
§5.5 calls "what makes this credible." The schema stores one deltaRatio (worst across the three
rendered viewports) and one before/after/diff image set, not a per-viewport breakdown — don't
narrate three separate percentages, the dashboard doesn't show three.*

---

## 1:40–2:10 — Three tiers, routed by task, not guessed

**VOICEOVER:**
"Every one of those steps goes through a single router, and it's not the same model doing
everything. Nano batch-classifies. Super adjudicates. Ultra only writes code and repairs
failures — the two things that are genuinely generative.

Here's the receipt, not the claim: this run cost thirteen cents. If every call had gone to Ultra
instead, it would have cost twenty-seven. That's a fifty percent saving, measured, confirmed
against the real Nebius pricing — not estimated."

**ON SCREEN:** Open the Cost panel (`/runs/[id]/cost`). Show the green "confirmed" banner, the
by-tier table, and the "All-Ultra counterfactual" card with real Actual / All-Ultra / Saved
numbers.

**ON-SCREEN TEXT:** "$0.13 actual vs. $0.27 all-Ultra — 50.6% saved. Ultra: 26.3% of calls."
(appears over the counterfactual card as the voiceover says "fifty percent saving")

*Recording note: real measured figures from a live run — $0.13 actual vs. $0.27 all-Ultra,
50.6% saved, 26.3% of calls on Ultra. Pricing confirmed directly against
tokenfactory.nebius.com/organization/prices.*

---

## 2:10–2:35 — Sandboxes: the part that makes this trustworthy

**VOICEOVER:**
"The render-and-diff loop runs inside a real Nebius Token Factory Sandbox — every patch,
isolated, disposable, never touching the host machine. One warm image per run, dependencies
installed once, then every candidate forks that same checkpoint instead of paying npm-install
cost per verification.

This is the part that separates Doppel from a model that just says 'looks fine.' Typecheck.
Lint. Pixel diff. A real verdict, or an honest 'I couldn't verify this' — never a guess."

**ON SCREEN:** A static diagram (built in editing, not filmed live): three boxes, "Warm image" →
fork → fork → fork, each fork labeled with a candidate name (e.g. Button / Badge / Card). Then
cut to a real finding card with the grey `UNVERIFIABLE` badge — scroll to the small grey box
below the rationale labeled "Couldn't verify this:", one line
(e.g. `error: original content failed to render: metrics is not defined`). No terminal, no log
viewer, no scrolling needed beyond that one box.

**ON-SCREEN TEXT:** "One warm image, forked per candidate — 2nd candidate: 12.8s (no reinstall)."
(appears over the diagram, not the finding card)

*Recording note: real architecture, confirmed live — one shared warm image reused across
candidates in the same run, proven by a second candidate completing in 12.8 seconds (no repeated
install) versus several minutes for the first.*

---

## 2:35–2:50 — We ran it on ourselves

**VOICEOVER:**
"We ran Doppel on Doppel's own dashboard. It found two real hand-rolled Cards in our own code —
one in the finding card component, one in the cost panel — that we'd written without noticing
they duplicated a component we already had. Then it opened a real pull request on a real
repo, with the patch, the screenshots, and the verdict table, ready for review."

**ON SCREEN:** Show the dogfood run's two real DRIFT findings. Cut to the real GitHub PR
(`pravoobi/drift-demo#1`) — title, verdict table, before/after images.

**ON-SCREEN TEXT:** "Dogfooded on Doppel's own dashboard — 2 real findings, 1 real PR." (appears
as the GitHub PR loads)

*Recording note: both are real, this session's own results — not staged examples.*

---

## 2:50–3:00 — Why this matters

**VOICEOVER:**
"Design-system drift isn't cosmetic. It's accessibility debt — hand-rolled components skip
focus rings and keyboard handling the real ones don't. It's brand debt. It's the thing every
design-system maintainer at a growing company already knows is happening and has no tool to
find. Doppel finds it, fixes it, and proves the fix is safe — before a human ever has to trust
it blind."

**ON SCREEN:** End card: project name, GitHub link (`github.com/pravoobi/doppel`), live demo
link (`doppel-web-eight.vercel.app`).

**ON-SCREEN TEXT:** "doppel" / "github.com/pravoobi/doppel" / "doppel-web-eight.vercel.app" (end
card, held for the last 3–4 seconds so judges can read it without pausing)

---

## Numbers reference (for narration accuracy — don't round further than shown)

| Claim | Number | Source |
|---|---|---|
| Fixture precision/recall | 100% / 100% | `docs/DECISIONS.md`, M1 gate |
| Candidates before shortlist | 68 | live scan |
| Survive shortlist (candidates model sees) | 18 | live scan |
| DRIFT candidates passing typecheck | 15/15 | M2 gate |
| Billing Alert deltaRatio (REVIEW) | 0.71% | latest local run, 2026-10-29 (`2750c2b2...`) |
| Cost: actual vs. all-Ultra | $0.13 vs $0.27 | live run, confirmed pricing |
| Cost saved by routing | 50.6% | same run |
| Ultra share of calls | 26.3% | same run |
| Warm-image reuse speedup | 12.8s (2nd candidate, no reinstall) | live smoke test |
| Dogfood real findings | 2 (both real `Card` duplications) | live dogfood run |
| Real PR | `pravoobi/drift-demo#1` | live GitHub test |

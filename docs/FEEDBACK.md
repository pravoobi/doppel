# Nebius Token Factory / NVIDIA tooling feedback

Drafted continuously while building, per CLAUDE.md §14 — not written the night before submission.
Ten $100 "Most Valuable Feedback" prizes exist and most teams skip this, so it's worth doing
properly.

Format per entry: what we hit, when, what we expected, what would have helped.

---

## 2026-09-23 — Reasoning models return `null` content with no signal that it's a budget problem

**What happened.** Ran a 20-token-budget chat completion against all four available Nemotron
models (`GET /v1/models` confirms: `NVIDIA-Nemotron-3-Nano-30B-A3B`, `Nemotron-3_5-Lightning`,
`nemotron-3-super-120b-a12b`, `Nemotron-3-Ultra-550b-a55b`), asking for a one-word reply. Nano and
Super both returned a well-formed `200` with `content: null` — `usage.completion_tokens` shows the
full 20-token budget consumed, and `completion_tokens_details.reasoning_tokens` shows the model
spent it all on internal chain-of-thought before ever producing the requested word. Ultra answered
correctly, but only because its reasoning happened to finish in 14 of 20 tokens.

**Why this matters.** Nothing in the response distinguishes "ran out of token budget mid-thought"
from "the model chose to answer with nothing." A caller reading `choices[0].message.content` sees
`null` either way. For a product that's explicitly pitched on routing cheap tasks to small/cheap
tiers to save credits (this hackathon's own "Nano/Super handle everyday calls" framing), that's a
sharp edge: a developer sizing `max_tokens` off the expected *answer* length — the natural thing
to do — gets silent empty responses from the cheaper tiers specifically, which looks like a model-
quality problem rather than a budget problem, and would plausibly steer people toward defaulting
to the most expensive tier just to make failures go away.

**What would help.** Either (a) a response field that flags "truncated by reasoning, retry with a
larger budget" distinct from an ordinary length-truncation stop reason, or (b) a documented,
enforced minimum recommended `max_tokens` per model that accounts for typical reasoning overhead,
so this doesn't have to be discovered empirically per integration.

**Evidence.** `scripts/spike.ts` step 2 in this repo; raw usage objects logged in
`docs/DECISIONS.md` under "Day-one spike run" (2026-09-23).

## 2026-09-23 — Sandboxes auth docs read as "separate IAM credential"; reality is the same API key

**What happened.** The Sandboxes API reference (`docs.tokenfactory.nebius.com/api-reference/
sandboxes/auth/get-current-token-information`) describes its auth as "IAM bearer token issued by
the Nebius IAM service... the recommended authentication scheme for new clients," which reads as
requiring a separate Nebius Cloud IAM token exchange, distinct from a Token Factory API key.
Empirically, the same `NEBIUS_API_KEY` used for chat completions worked directly as the bearer
token against `GET /sandboxes/v1/whoami` (with a `Project` header, any non-empty value accepted) —
no separate credential or exchange step needed.

**What would help.** A single sentence on that auth page confirming "this is the same API key as
Token Factory inference" would have saved real investigation time — I initially assumed a second
credential was required and started planning around a Python `contree-sdk` fallback for that
reason alone, before testing empirically.

**Separately, discovered while testing:** the key I have currently returns all-`false` Sandboxes
permissions (`import`/`spawn`/`spawn_disposable`/`list`/`cancel`/`set_image_tag`) via `/whoami`,
confirmed by a `403 Insufficient permissions: list` on `GET /images`. If Sandboxes access requires
a separate enablement step from Token Factory inference access, that's worth stating explicitly
somewhere a new integrator would see it before they start (e.g. the overview page) — I only found
it by testing every permission-gated endpoint by hand.

**Evidence.** `scripts/spike.ts` steps 3-4 in this repo; full request/response trace in
`docs/DECISIONS.md` under "Day-one spike run" (2026-09-23).

## 2026-09-23 — `strict: true` structured outputs guarantee valid JSON, not complete content

**What happened.** Building a codegen pipeline (Nemotron Ultra generating JSX as a JSON string
field) that kept getting truncated output: a well-formed, schema-valid JSON response where the
target string field was cut short mid-content (e.g. a literal raw value of `"<Alert variant="`, 15
characters, abandoned before the closing quote of an attribute value). Hypothesized this was a
quote-escaping bug under loose (`strict: false`) JSON mode — the model failing to escape a literal
`"` inside the JSX when embedding it as a JSON string, causing the string to terminate early.
Tested `strict: true` on the exact same failing input to see if real grammar-constrained decoding
would prevent it. The API accepted `strict: true` without complaint. The output was **byte-for-byte
identical**: still `"<Alert variant="`.

**Why this matters.** This proves the JSON was syntactically valid the entire time — the model was
choosing to close the string and move on with genuinely incomplete content, not failing to escape a
character. Grammar-constrained decoding (whatever `strict: true` actually does server-side for
these models) enforces JSON *shape*, but has no mechanism to enforce that a free-form string
field's *content* is complete or correct — and it's easy to assume otherwise, since "structured
outputs" implies more of a completeness guarantee than it apparently delivers here. Worth being
explicit about this boundary in the docs: `strict` mode guarantees your code won't need a JSON
parser fallback, not that a long string field won't be truncated by the model choosing to stop
early.

**What would help.** Documentation stating plainly what `strict: true` does and doesn't guarantee
for Nemotron models specifically (does it change decoding at all, or just validate post-hoc and
retry internally?), and/or a finish_reason variant that distinguishes "the model chose to stop"
from "the schema was satisfied" for cases like this where a string value is suspiciously short
relative to the task.

**Evidence.** Isolated single-call reproduction (not part of the committed scripts, but the same
`migrateCandidate`/`route.ts` path in `packages/agent`); full trace in `docs/DECISIONS.md` under
"M2 built" (2026-09-23), bug #6.

## 2026-09-23 — Root cause of the above: double-quote escaping inside JSON string values is unreliable

**What happened.** Following up on the previous entry: the actual root cause of the truncated
JSON-string content (bug #6 above) turned out to be identifiable and fixable. The task was
generating JSX as a JSON string field — code that itself needs double-quoted attribute values
(`variant="destructive"`), which means the model has to emit an escaped `\"` mid-string to
represent standard JSX style. Across many real migrations, this specific escaping task was where
generation reliably went wrong: the model would write up to the point of needing an escaped quote,
then stop, closing the string early. This happened whether or not `strict: true` was set, and
regardless of `max_tokens` headroom — it wasn't a truncation-by-budget problem, it was the model
consistently struggling with one specific character-escaping task inside a code-generation string.

**What fixed it.** Instructing the model to use single quotes for JSX attribute values instead
(`variant='destructive'`) — a JSON string never needs to escape `'`, so the failure mode becomes
structurally impossible regardless of the model's escaping reliability. Verified on the
single-worst-performing candidate (previously failing on 4 of the last 5 runs): 3/3 clean after the
change. Full pipeline re-run: **15/15 candidates passed** (up from a prior best of 9/15, and as low
as 3/15 on a bad run) — zero repairs needed, zero truncation, on the exact same prompts/model/task
otherwise.

**Why this matters for anyone doing LLM code generation through structured JSON outputs on these
models:** "the model can produce valid JSON" (confirmed true, even under `strict: true`) is not the
same guarantee as "the model can reliably escape arbitrary characters inside a JSON string value
containing code." The gap between those two is invisible until you inspect raw output directly —
schema validation alone won't catch it, since a truncated-but-terminated string still validates.

**What would help.** If this is a known pattern (it has the shape of a reasonably common LLM
structured-output failure mode, not something specific to this one prompt), documentation flagging
it explicitly for anyone doing code-gen-via-JSON-string on these models would save real debugging
time — something like "prefer escape-free content in string fields where possible; nested quotes
inside a JSON string field are a common source of truncated output."

**Evidence.** `docs/DECISIONS.md` under "M2 built" (2026-09-23), bug #8 — includes the before/after
pass counts and the isolated-test methodology used to verify cheaply before a full re-run.

## 2026-09-23 — Large sandbox stdout silently switches to base64 encoding, undocumented

**What happened.** Building a verification pipeline that captures Playwright screenshots as
base64-encoded PNGs printed to stdout inside a sandbox, then reads them back via `GET /v1/
operations/{uuid}`. A short command (`echo hello`) returns `metadata.result.stdout` as `{ value:
"hello\n", encoding: "ascii" }` — literal text, as expected. A command whose stdout contained
several KB of base64 screenshot data came back as `{ value: "<base64 blob>", encoding: "base64" }`
— the ENTIRE stdout value itself re-encoded as base64, presumably to avoid escaping issues
transporting arbitrary bytes/large payloads safely inside JSON.

**Why this matters.** Nothing about this fails loudly. A client that reads `stdout.value` as
literal text (a completely reasonable assumption from the "ascii" case, and there's no error,
warning, or size threshold documented anywhere) gets back a big blob of plausible-looking text
that simply doesn't contain any of the markers/content it's supposed to. It cost real debugging
time across two separate-looking "failures" in this session before the actual pattern (encoding
flips based on payload, not documented anywhere in the fetchable API reference) was identified by
manually base64-decoding a captured log and finding complete, correct, well-formed output hiding
underneath what looked like silent truncation.

**What would help.** Documenting the `encoding` field's possible values and the condition that
triggers a switch from `"ascii"` to `"base64"` (a size threshold? presence of certain byte
values?) on the operations/instances API reference page. This is exactly the kind of behavior a
generic JSON-schema/OpenAPI type definition wouldn't capture but a sentence of prose would.

**Evidence.** `docs/DECISIONS.md` under "M3 gate cleared" (2026-09-23), bug #4; fix in
`packages/verifier/src/sandbox.ts`'s `decodeStream` function; regression tests in
`packages/verifier/test/sandbox.test.ts`.

## 2026-09-23 — Chromium blocks ES module scripts loaded from file:// (not sandbox-specific, but worth flagging in context)

**What happened.** Building the same verification pipeline, screenshotting a Vite-built static
site by navigating Playwright directly to the built `index.html` via a `file://` URL. The page
loaded (network tab clean, no console errors surfaced through normal means) but never executed
any application code — a custom "mounted" signal the app sets on `document.body.dataset` never
appeared, timing out every time regardless of the configured timeout value.

**Why this matters for anyone building on Sandboxes for visual verification specifically.** This
is a known, general Chromium restriction (ES module `<script type="module">` tags are blocked from
loading over `file://` origins) — not a Nebius/Sandboxes bug. Flagging it here anyway because the
natural, obvious way to screenshot a locally-built static site inside an ephemeral sandbox is
`page.goto("file:///path/to/dist/index.html")`, and any guide or example showing Playwright +
Sandboxes for visual/build verification of a modern (Vite/ESM-output) frontend should call this
out explicitly — a would-be integrator will hit this immediately and the failure mode (silent
timeout, no clear error) gives no hint about the actual cause.

**What would help.** A one-line note in any Sandboxes + Playwright example or guide: "serve built
static output over a local HTTP server inside the sandbox, don't `page.goto()` a `file://` URL for
anything using ES module scripts." Cheap to state, saves real time.

**Evidence.** `docs/DECISIONS.md` under "M3 gate cleared" (2026-09-23), bug #3; fix in
`packages/verifier/src/shoot.ts`'s generated script, which now starts a minimal `http`/`fs`-based
static server on an ephemeral port instead of using a `file://` URL.

## 2026-09-23 — Sandboxes' available base images don't match a new integrator's first guess

**What happened.** Building the verification pipeline's warm base image, the natural first choice
was `tag:node:22-slim` — Node 22 is the current LTS at time of writing, and it's what this project's
own `engines` field requires everywhere else. Spawning against it failed outright: it's not in this
account's pre-registered image catalog. `GET /v1/images` (found by checking the API reference for
an images-listing endpoint, not documented as a first step anywhere in the Sandboxes quickstart)
shows the real available set — `node:20-slim` is on it, `node:22-slim` isn't. Switching tags fixed
it immediately; Node 20 is fine for everything this project needs. Cost was low here (one fast `404`
caught by checking the catalog live before spawning again, not by guessing a second time) — but
that's a discipline this team adopted after getting burned by guessing elsewhere in this same
project, not something the Sandboxes onboarding flow itself prompts you toward.

**Why this matters.** The Sandboxes quickstart's own example uses `ubuntu:latest`, which doesn't
tell an integrator anything about what's available for other common base images. Node's LTS
cadence means "the current LTS tag" is a moving target, so whatever's pre-registered today will
eventually be stale again for whoever reads the docs next. Nothing in the onboarding flow points at
`GET /v1/images` as the step to run before picking a tag — we found it by exploring the API
reference for something adjacent, not because it was called out as necessary.

**What would help.** One sentence in the Sandboxes quickstart: "see `GET /v1/images` for the base
images available to your account — not every public Docker Hub tag is pre-registered." Cheap to
state, and it would have saved the one wasted spawn attempt (small on its own, but this is exactly
the kind of thing that compounds when an image catalog changes account-to-account or over time).

**Evidence.** `docs/DECISIONS.md` under "M3 gate cleared" (2026-09-23), bug #1; the confirmed
working tag lives in `scripts/m3-pipeline.ts` and `apps/web/lib/verify-run.ts`'s `BASE_IMAGE`
constant, each with a comment explaining why `node:20-slim` was chosen over the more obvious guess.

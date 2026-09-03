# Task Handoff Protocol (THP) — Design

Status: **draft, awaiting approval**. No code has been written. This document
covers Phase 0 only: monorepo layout, spec format, routing engine, and risks.

---

## 1. Monorepo layout

Accepting the proposed shape with one addition and one explicit rejection.

```
thp/
├── docs/
│   └── DESIGN.md
├── examples/
│   └── fix-flaky-test.thp.md        # not a package, just a fixture for the README
├── packages/
│   ├── schema/                      # @thp/schema
│   ├── core/                        # @thp/core
│   ├── cli/                         # @thp/cli   (bin: thp)
│   └── vscode/                      # @thp/vscode (extension id: thp)
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

**packages/schema** — kept separate, as proposed. Reasoning: the JSON Schema
needs to be fetchable by editor tooling (yaml-language-server's
`# yaml-language-server: $schema=` modeline, or a future schemastore.org
submission) without pulling in `core`'s runtime dependencies (SDK clients,
better-sqlite3). It stays a distinct workspace package now; whether it's
published to npm on its own cadence is a decision I'll defer until Phase 3 —
no need to commit to that today. `core` depends on it via the workspace
protocol so there is exactly one copy of the schema.

**packages/core** — spec parser, router, provider adapters, result envelope,
telemetry store, workspace-config loader. Zero `vscode` imports, enforced by
an ESLint rule (`no-restricted-imports` on `vscode`) plus a CI check that
greps for it — belt and suspenders, since this constraint is the entire
reason phases 2–4 are supposed to be cheap.

**packages/cli** — thin headless wrapper over `core`. No business logic here
beyond argument parsing, JSON/table output formatting, and process exit
codes.

**packages/vscode** — thin adapter over `core`. Commands, tree view, webview,
status bar, secrets, Antigravity capability probe. No routing or provider
logic here — if I catch myself writing scoring or dispatch logic in this
package, that's a bug in the layout.

**What I'm not adding:**
- No `packages/config` — workspace-config loading (`.thp/config.json`) is
  small and used by both `cli` and `vscode`, both of which already depend on
  `core`. It lives in `core/src/config.ts`. A separate package for it would
  be a one-consumer abstraction.
- No `packages/types` — `core` already has zero `vscode` deps, so there's
  nothing blocking `cli` and `vscode` from importing types directly from
  `core`. A types-only package would just be indirection.

**Tooling** (so Phase 1 doesn't stall on setup bikeshedding):
- pnpm workspaces with a shared `tsconfig.base.json`. (Considered
  `composite: true` project references for incremental builds, but dropped
  it — it conflicts with tsup's isolated `.d.ts` bundling step, and nothing
  in this repo actually consumes project references yet. Revisit only if
  cross-package incremental builds become a real bottleneck.)
- `tsup` to build `schema`/`core`/`cli` as dual ESM+CJS — `core` will be
  consumed from a VS Code extension host (historically CJS-friendly,
  ESM-capable in recent versions) and from arbitrary CLI/CI Node
  environments. Dual output avoids forcing a module-format choice on
  consumers.
- `esbuild` to bundle `packages/vscode` into a single CJS file, the
  well-trodden path for `vsce`/`ovsx` packaging.
- `vitest` for tests — native ESM, first-class async-iterator/streaming test
  support, which `Provider.dispatch()`'s `AsyncIterable<DispatchEvent>` needs.
- `changesets` for independent versioning across four packages with two of
  them (schema, core/cli) going to npm and one (vscode) going to two
  marketplaces.
- `strict: true` + `noUncheckedIndexedAccess: true` everywhere.
- Package scope `@thp/*` is a placeholder — I have not checked npm for
  availability and won't assert it's free without checking at publish time.

---

## 2. Spec format — `.thp.md`

Frontmatter (YAML) for machine fields, markdown body for human intent.
Discovered in a workspace via `**/*.thp.md` (excluding `node_modules`, `.git`).

### Minimal valid spec (5 lines)

```markdown
---
taskType: bugfix
---
# Fix flaky retry test
The retry test fails under load; make it deterministic.
```

### Realistic spec

```markdown
---
id: fix-flaky-retry-test
taskType: bugfix
contextGlobs:
  - src/retry.ts
  - test/retry.test.ts
acceptance: pnpm test -- retry.test.ts
constraints:
  - no new dependencies
budget:
  maxUsd: 0.50
  maxLatencyMs: 120000
expects: diff
---

# Fix flaky retry test

`test/retry.test.ts` fails intermittently under load because `retry.ts` uses
`Date.now()` for backoff jitter without seeding. Make the jitter
deterministic under test without changing production behavior.
```

### Field-by-field decisions

| Field | Required? | Default | Decision |
|---|---|---|---|
| `taskType` | **yes** | — | Only truly required field. Drives capability filtering and affinity scoring (§3). Open string, not a closed enum — unknown values just get no affinity bonus, so this never hard-fails on a typo or a new task category. |
| `id` | no | slug of filename | Kept optional, unlike your proposal. Requiring it on every hand-written file adds boilerplate for no benefit in the common case; a stable filename is a fine identity. If you rename the file, telemetry history for the old id becomes orphaned — the parser will warn (not error) when a spec has no explicit `id`, so people who care about renames can pin one. |
| `contextGlobs` | no | `[]` | Defaulting to "everything" is unsafe (blows context windows, leaks unintended files) and not actually a smaller schema — it just moves the danger from explicit to implicit. Default to empty; the parser doesn't punish you for omitting it, but you get no file context unless you ask. |
| `acceptance` | no | — (see below) | **This is where I differ from your proposal most.** See "On `acceptance` being optional" below. |
| `constraints` | no | `[]` | Free-text list, injected verbatim into the prompt for every provider. Not structured further — no constraint DSL. |
| `budget` | no | workspace default → hardcoded floor | `{ maxUsd?, maxLatencyMs? }`. Most specs shouldn't restate this. Resolution order: spec field → `.thp/config.json` workspace default → a hardcoded safety ceiling (proposed: $1.00 / 5 min) so a workspace with no config file yet still can't accidentally trigger an unbounded-cost dispatch. |
| `pinnedProvider` | no | — | Escape hatch, format `providerId` or `providerId:modelId` (e.g. `anthropic:claude-sonnet-5`) so you can pin a specific model without a second field. Pinning skips *scoring*, not the budget hard ceiling — see §3. |

**Field I'm adding that you didn't list: `expects`.**
`expects: diff \| artifact \| message` (default `diff`). Phase 1.3 explicitly
asks the router to "filter by hard capability requirements... structured
output" — there is no way to do that filtering without the spec declaring
what shape of output it wants. This is one field, directly load-bearing for
a requirement already in scope, not speculative generality.

**Fields I'm rejecting** (kept out to keep the schema hand-writable):
- `title` — derive from the first `#` heading in the body instead of a
  redundant frontmatter field.
- `status` (draft/running/passed/failed) — this is *derived* from the
  telemetry store, never authored. Putting it in frontmatter would create a
  second, stale source of truth that the sidebar tree view would have to
  reconcile against reality.
- `retries` / `maxAttempts` — fallback-chain depth is a router-config
  concern (`.thp/config.json`), not a per-task concern. No one asked for
  per-spec retry tuning.
- `dependencies` / `relatedSpecs` — spec-graph chaining is a feature nobody
  requested; rejecting on "no plugin system for the plugin system" grounds.

### On `acceptance` being optional

Your prompt treats `acceptance` as a given — "a shell command that must exit
0" — and the rest of the system (1.4: "a dispatch that produces a diff but
fails acceptance is a failure") is built assuming it exists. I'm keeping it
**optional in the schema** but changing what happens when it's absent:

- Present → normal path. Exit 0 is `pass`, anything else is `fail`.
- Absent → the envelope's acceptance result is `status: "skipped"`, not
  `pass`. The UI, CLI JSON output, and cost report all render "unverified"
  distinctly from "passed" — never conflated.

Reasoning: some real tasks have no automatable acceptance ("write release
notes," "explain this function," most `taskType: explain`/`docs` work).
Forcing every spec to invent a fake shell command to satisfy a required
field produces either (a) people writing `acceptance: "true"` to get past
validation, which is worse than no acceptance at all because it *looks*
verified in the cost report, or (b) people not writing `.thp.md` files for
that whole category of task. Making it optional-but-distinctly-labeled keeps
the schema honest without making it mandatory. The `THP: New Spec` template
will still include a commented-out acceptance line and the parser will emit
a lint-level warning (not error) on specs with no acceptance, so the path of
least resistance still nudges toward writing one.

---

## 3. The routing decision

### 3.1 Capability matrix

One profile per (provider, model). Shipped defaults live in
`core/src/capability-matrix.ts` as data, not code, and are fully overridable
per-workspace in `.thp/config.json` — required for the OpenAI-compatible
adapter anyway, since a local llama.cpp/Ollama endpoint has no way to be
known in advance.

```ts
interface CapabilityProfile {
  providerId: string;
  modelId: string;
  taskTypeAffinity: Record<string, number>; // 0..1, hand-curated prior
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  asOf: string; // ISO date the pricing/affinity numbers were last checked
}
```

Illustrative starting defaults (task-type affinities below are **placeholder
priors for the router to start from, not a benchmarked quality claim** — I
have not evaluated these models against each other, and the numbers are
meant to be tuned per-workspace as telemetry accumulates):

| provider:model | codegen | refactor | bugfix | test-gen | docs | context window |
|---|---|---|---|---|---|---|
| anthropic:claude-sonnet-5 | 0.85 | 0.85 | 0.85 | 0.80 | 0.75 | 200k |
| google:gemini-3 | 0.80 | 0.75 | 0.75 | 0.75 | 0.80 | 1M |
| openai-compat:gpt-oss | 0.70 | 0.70 | 0.70 | 0.70 | 0.70 | model-reported |
| openai-compat:local (llama.cpp/Ollama) | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | model-reported |

The flat 0.50 for arbitrary local models is deliberate: THP has no prior on
an endpoint it's never seen, so it shouldn't pretend to.

### 3.2 Hard filter (survivors only move on to scoring)

A candidate is eliminated, with a stated reason, if any of:
1. No credentials configured for that provider (no key in SecretStorage /
   env for the CLI).
2. Estimated required tokens (body + resolved `contextGlobs` + fixed
   overhead) exceed `contextWindowTokens`.
3. `expects: artifact` or a tool-driven diff strategy requires
   `supportsTools` and the profile says `false`.
4. `expects: message` with a structured-output requirement and
   `supportsStructuredOutput: false`.
5. `estimate(spec).usd` exceeds the resolved `budget.maxUsd`, or
   `estimate(spec).expectedLatencyMs` exceeds `budget.maxLatencyMs` — **unless**
   `pinnedProvider` names this candidate, in which case it survives but is
   flagged `overBudget: true` and the dispatch requires an explicit
   `--force` (CLI) or a confirmation dialog (VS Code) before it's allowed to
   spend past the ceiling. Pinning selects the provider; it does not
   silently disable the safety ceiling.

### 3.3 Scoring function

For every surviving candidate:

```
score = w_cost'      * normCost
      + w_latency'    * normLatency
      + w_success'    * successRate
      + w_affinity'   * affinity
```

- `normCost = 1 − estimate.usd / costCeiling`, clamped to [0,1].
  `costCeiling = min(resolved budget.maxUsd, max estimate.usd among
  survivors)` — avoids division by zero when no budget is configured and
  ensures the cheapest survivor doesn't automatically get a perfect 1.0 in a
  field where all candidates are already expensive.
- `normLatency` — same shape, using `expectedLatencyMs`.
- `affinity` = `taskTypeAffinity[spec.taskType] ?? 0.5` (unknown task type →
  neutral, not zero — an unrecognized taskType shouldn't look like a
  disqualification).
- `successRate` = Laplace-smoothed historical pass rate for this
  (provider, taskType) pair from the telemetry store:
  `(successes + 1) / (attempts + 2)`. With zero attempts this is exactly
  0.5 — the "no information" prior — for every candidate equally, so it
  contributes nothing discriminative until real data exists. This is *why*
  Laplace smoothing was chosen over a 0/1 default: a 0-default would punish
  every untested provider, a 1-default would let a single lucky success
  dominate.

**Default weights** (`w_cost=0.25, w_latency=0.20, w_success=0.35,
w_affinity=0.20`), configurable in `.thp/config.json` under `router.weights`.
Success rate gets the largest weight *at full confidence* because it's
ground truth for this codebase and this task type, more reliable than a
static affinity guess — but "full confidence" is not the default state; see
cold start.

### 3.4 Cold start — confidence-scaled weight redistribution

Laplace smoothing alone isn't enough: after exactly one recorded attempt,
one provider's smoothed rate jumps to 0.667 while every untested provider
sits at 0.5, which lets a single data point swing 35% of the score before
there's any real signal. To fix this, the *weight itself* on the
success-rate term scales with sample size, and the freed-up weight is
redistributed proportionally to the other three terms so weights always sum
to 1:

```
confidence   = min(1, attempts / N0)        // N0 = 5, configurable
w_success'   = w_success * confidence
leftover     = w_success − w_success'
w_cost'      = w_cost     + leftover * w_cost     / (w_cost + w_latency + w_affinity)
w_latency'   = w_latency  + leftover * w_latency  / (w_cost + w_latency + w_affinity)
w_affinity'  = w_affinity + leftover * w_affinity / (w_cost + w_latency + w_affinity)
```

Worked example, `N0 = 5`, task type has 0 attempts for every candidate:
`confidence = 0`, so `w_success' = 0` and the entire 0.35 is redistributed
across cost/latency/affinity in their existing 0.25:0.20:0.20 ratio →
`w_cost' ≈ 0.399, w_latency' ≈ 0.319, w_affinity' ≈ 0.319, w_success' = 0`.
The router is, correctly, purely cost/latency/affinity-driven on a brand new
workspace. At `attempts = 5` for a given (provider, taskType) pair,
`confidence = 1` and that pair's score uses the full shipped weights. Every
other (provider, taskType) pair keeps scaling independently — confidence is
per-pair, not global, so a workspace that has dispatched 50 `bugfix` tasks
but zero `docs` tasks is still cold-start for `docs`.

### 3.5 Fallback chain

`router.route(spec)` returns an **ordered list** of scored candidates, not a
single winner. The dispatch orchestrator (in `core`, called identically by
`cli` and `vscode`) tries them in order:

- Advance to the next candidate on adapter error (thrown exception,
  timeout, non-2xx) **or** on acceptance-check failure.
- The budget ceiling applies **cumulatively across the whole chain** — a
  spec with `maxUsd: 0.50` cannot spend $0.50 four separate times by
  falling through four providers. Each attempt's estimated cost is
  subtracted from the remaining budget before the next candidate is tried;
  if no remaining candidate fits what's left, the chain stops and the
  envelope is marked failed with `reason: "budget exhausted"`.
- Every attempt (including failed ones) is recorded in the envelope's
  `attempts: DispatchAttempt[]` and written to telemetry — a failed
  fallback attempt is exactly the kind of data point the success-rate term
  needs.

### 3.6 `explain(spec)`

Returns the full breakdown as data, including eliminated candidates and why:

```ts
interface RoutingExplanation {
  specId: string;
  generatedAt: string;
  weights: { cost: number; latency: number; successRate: number; affinity: number };
  candidates: Array<{
    providerId: string;
    modelId: string;
    eliminated: boolean;
    eliminationReason?: string;
    overBudget?: boolean;
    estimate: { usd: number; expectedLatencyMs: number; confidence: number };
    affinity: number;
    successRate: { attempts: number; successes: number; smoothed: number; confidence: number };
    score?: number;
    rank?: number;
  }>;
}
```

This is rendered by the VS Code webview as a plain table (per your spec: no
colored cell fills) and printed by `thp explain` as a text table — same data,
two renderers, no logic duplicated between them.

---

## 4. Risks — three most likely ways this ships broken

**1. `better-sqlite3` breaks packaging on some platform/arch/consumer.**
Native modules need a matching prebuilt binary for the OS/arch and the
Node/Electron ABI they run under. This module is used by `core`, which is
loaded from *three* of the four target surfaces (VS Code extension host,
the CLI under whatever Node the user or CI has, and transitively by
Antigravity/Cursor/Windsurf since they're VS Code forks with their own
bundled Node/Electron). "Works on the maintainer's Mac, crashes on Windows
or Linux ARM CI" is the single most common way native-dependent VS Code
extensions break in the wild, and it hits exactly the surfaces this project
is betting on. Mitigation: wrap the telemetry layer's native-module load in
a try/catch at startup — a failed load degrades to an in-memory-only store
with one clear diagnostic, never a crashed activation; evaluate shipping
prebuilt binaries for the common platform/arch matrix; keep the
`TelemetryStore` behind an interface so a pure-JS fallback (or Node's
built-in, still-experimental `node:sqlite` on newer runtimes) is a
contained swap later, not a rewrite.

**2. The capability matrix's cost/affinity numbers go stale and the router
looks authoritative while being wrong.** Provider pricing and model
line-ups change often; a hardcoded table will drift from reality, and
because `explain()` presents numbers in a clean table, users are more
likely to trust a wrong number than they would a vague one. This is worse
than the router being obviously approximate. Mitigation: every
`CapabilityProfile` carries an `asOf` date, shown in the explain view;
config lives in an easily-editable workspace JSON file, not buried in
compiled code, so updating pricing doesn't require a new release; no
promise of live-fetched pricing in v1 (that would trade one staleness
problem for a new external-dependency failure mode).

**3. Running the `acceptance` command is a real code-execution surface,
and a naive implementation makes it worse than doing nothing.** A `.thp.md`
file can carry an arbitrary shell command, and the file it's checked against
may just have been rewritten by an AI provider — a spec pulled from a
shared repo, or a provider that picks up prompt-injected instructions from
`contextGlobs` content, both turn "run the acceptance command" into
attacker-influenced code execution if handled carelessly. The specific
failure mode to avoid: applying an AI-produced diff straight to the real
working tree and *then* running acceptance against it — by the time
acceptance reports failure, whatever the diff did has already happened.
Mitigation: verify diffs in a scratch worktree/temp checkout, not the live
working tree, only fast-forwarding into the real tree on a pass (or with
explicit confirmation on failure); run the acceptance subprocess with a
stripped environment (no inherited provider API keys or unrelated secrets),
a hard timeout, and a working-directory jail; require explicit user
confirmation the first time a given acceptance command is seen or changes,
the same trust-on-first-use model editors use for workspace tasks.

---

## Summary of decisions that differ from or add to your proposal

1. Kept your 4-package layout; explicitly rejected a `config` or `types`
   package as unnecessary indirection.
2. Made `id` optional (default: filename slug) instead of required.
3. Made `acceptance` optional with a distinct `"skipped"` verification
   status, instead of required — this is the biggest deviation and the one
   most worth you pushing back on if you disagree.
4. Added an `expects: diff | artifact | message` field, needed for the
   structured-output hard filter Phase 1.3 already asks for.
5. Rejected `title`, `status`, `retries`, `dependencies` as spec fields.
6. Specified cold start as two mechanisms (Laplace-smoothed point estimate
   + confidence-scaled weight redistribution), not one.

Awaiting approval before starting Phase 1.

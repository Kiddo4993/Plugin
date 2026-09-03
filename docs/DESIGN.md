# Task Handoff Protocol (THP) — Design

Status: approved. This is the Phase 0 plan as it was written and agreed
before any code existed — monorepo layout, the `.thp.md` spec format, the
routing engine, and the risks. Phase 1 (`packages/core`) has since been
built against it; see the repo's commit history for what actually landed.
I've left this document as it was at approval time rather than rewriting
it after the fact, since it's useful to see what was decided going in and
why.

---

## 1. Monorepo layout

Going with the shape you proposed, plus one addition and one thing I'm
deliberately leaving out.

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

`packages/schema` stays separate, as proposed. The reason: the JSON Schema
needs to be fetchable by editor tooling — yaml-language-server's
`# yaml-language-server: $schema=` modeline, maybe eventually a
schemastore.org submission — without dragging in everything `core` depends
on (SDK clients, better-sqlite3). So it's its own workspace package for
now. Whether it ever gets published to npm on its own schedule is a call
I'll make in Phase 3; no need to decide that today. `core` depends on it
through the workspace protocol, so there's only ever one copy of the
schema in play.

`packages/core` holds the spec parser, router, provider adapters, result
envelope, telemetry store, and workspace-config loader. It has zero
`vscode` imports — enforced by an ESLint rule and a CI check, not just a
comment saying please don't — because that constraint is basically the
whole reason phases 2 through 4 get to be cheap.

`packages/cli` is a thin headless wrapper over `core`: argument parsing,
JSON/table output, exit codes, and not much else.

`packages/vscode` is a thin adapter too — commands, tree view, webview,
status bar, secrets, the Antigravity probe. If I ever catch myself writing
scoring or dispatch logic in this package, that's a sign the layout has
gone wrong somewhere.

Two things I'm deliberately not adding. First, a `packages/config`:
workspace-config loading (`.thp/config.json`) is small, and both `cli` and
`vscode` already depend on `core` anyway, so it just lives in
`core/src/config.ts` — a separate package would only have one real
consumer group. Second, a `packages/types`: since `core` already has zero
`vscode` dependencies, nothing stops `cli` and `vscode` from importing
types directly from it. A types-only package would just be indirection.

A few tooling calls up front, so Phase 1 doesn't stall on setup decisions:

- pnpm workspaces with one shared `tsconfig.base.json`. I considered
  `composite: true` project references for incremental builds, but
  dropped the idea — it conflicts with tsup's isolated `.d.ts` bundling
  step, and nothing here actually needs project references yet.
- `tsup` builds `schema`/`core`/`cli` as dual ESM+CJS. `core` gets
  consumed both from a VS Code extension host and from whatever Node
  environment a CLI or CI job happens to have, so it's better not to
  force a module format on either side.
- `esbuild` bundles `packages/vscode` into a single CJS file — the
  well-worn path for `vsce`/`ovsx` packaging.
- `vitest` for tests, mainly because it handles async-iterator/streaming
  tests natively, which `Provider.dispatch()`'s
  `AsyncIterable<DispatchEvent>` needs.
- `changesets` for versioning across four packages that publish to two
  different places (npm for schema/core/cli, two marketplaces for
  vscode).
- Strict TypeScript everywhere, including `noUncheckedIndexedAccess`.
- The `@thp/*` npm scope is a placeholder. I haven't checked whether it's
  actually free, and won't claim it is before publish time.

---

## 2. Spec format — `.thp.md`

YAML frontmatter for the machine-readable fields, a markdown body for the
human intent. Discovered across a workspace via `**/*.thp.md`, excluding
`node_modules` and `.git`.

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
| `taskType` | **yes** | — | The only truly required field. Drives capability filtering and affinity scoring (§3). It's an open string, not a closed enum, so an unrecognized value just gets no affinity bonus rather than failing validation on a typo or a new task category. |
| `id` | no | slug of filename | Kept optional, unlike your proposal. Requiring it on every hand-written file is boilerplate for no real benefit — a stable filename is a fine identity on its own. Rename the file and the old id's telemetry history becomes orphaned, so the parser warns (doesn't error) when a spec has no explicit `id`, and anyone who cares about renames can pin one. |
| `contextGlobs` | no | `[]` | Defaulting to "everything" would be unsafe — it blows context windows and leaks files nobody meant to include — and doesn't actually make the schema smaller, it just moves the danger from explicit to implicit. So it defaults to empty: omitting it costs nothing, but you get no file context unless you ask for it. |
| `acceptance` | no | — (see below) | This is where I differ from your proposal the most. See "On `acceptance` being optional" below. |
| `constraints` | no | `[]` | A free-text list injected verbatim into the prompt for every provider. Nothing more structured than that — no constraint DSL. |
| `budget` | no | workspace default → hardcoded floor | `{ maxUsd?, maxLatencyMs? }`. Most specs shouldn't need to restate this. Resolution order is spec field, then `.thp/config.json`'s workspace default, then a hardcoded safety ceiling (proposed at $1.00 / 5 min) so a workspace with no config file yet still can't trigger an unbounded-cost dispatch by accident. |
| `pinnedProvider` | no | — | An escape hatch, written as `providerId` or `providerId:modelId` (e.g. `anthropic:claude-sonnet-5`) so you can pin down to a specific model without needing a second field. Pinning skips scoring, not the budget's hard ceiling — see §3. |

One field I'm adding that you didn't list: `expects`, written as
`diff | artifact | message` and defaulting to `diff`. Phase 1.3 asks the
router to filter on hard capability requirements including structured
output, and there's no way to do that filtering without the spec
declaring what shape of output it actually wants. It's one small field,
directly load-bearing for a requirement already in scope — not
speculative generality.

A few fields I'm leaving out, to keep the schema something people will
actually hand-write:

- `title` — better derived from the first `#` heading in the body than
  duplicated as a frontmatter field.
- `status` (draft/running/passed/failed) — this is derived from the
  telemetry store, never authored. Putting it in frontmatter would create
  a second, stale source of truth that the sidebar tree view would have
  to reconcile against reality.
- `retries` / `maxAttempts` — fallback-chain depth is a router-config
  concern that belongs in `.thp/config.json`, not something to tune per
  task. Nobody's asked for that granularity.
- `dependencies` / `relatedSpecs` — spec-graph chaining is a feature
  nobody requested. Rejecting it on "no plugin system for the plugin
  system" grounds.

### On `acceptance` being optional

Your prompt treats `acceptance` as a given — "a shell command that must
exit 0" — and the rest of the system (1.4: "a dispatch that produces a
diff but fails acceptance is a failure") is built assuming it exists. I'm
keeping it optional in the schema, but changing what happens when it's
missing:

- Present → the normal path. Exit 0 is a pass, anything else is a fail.
- Absent → the envelope's acceptance result is `status: "skipped"`, never
  `"pass"`. The UI, the CLI's JSON output, and the cost report all render
  "unverified" as visibly distinct from "passed" — the two never get
  conflated.

Some real tasks just don't have anything automatable to check — "write
release notes," "explain this function," most `docs`/`explain` work in
general. Making `acceptance` required would push people toward one of two
bad outcomes: writing `acceptance: "true"` just to get past validation
(worse than having none, because it *looks* verified in the cost report),
or simply not writing `.thp.md` files for that whole category of task.
Optional-but-clearly-labeled keeps the schema honest without forcing
everyone's hand. The `THP: New Spec` template still ships with a
commented-out acceptance line, and the parser emits a lint-level warning
(not an error) on a spec with none, so the path of least resistance still
nudges people toward writing one.

---

## 3. The routing decision

### 3.1 Capability matrix

One profile per (provider, model). The shipped defaults live in
`core/src/capability-matrix.ts` as plain data, not code, and are fully
overridable per workspace in `.thp/config.json` — which is a requirement
anyway, since a local llama.cpp/Ollama endpoint has no way of being known
in advance.

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

Some starting defaults to illustrate the shape (the task-type affinity
numbers below are a prior for the router to start from, not a benchmarked
quality claim — I haven't evaluated these models against each other, and
the numbers are meant to be tuned per workspace as telemetry builds up):

| provider:model | codegen | refactor | bugfix | test-gen | docs | context window |
|---|---|---|---|---|---|---|
| anthropic:claude-sonnet-5 | 0.85 | 0.85 | 0.85 | 0.80 | 0.75 | 200k |
| google:gemini-3 | 0.80 | 0.75 | 0.75 | 0.75 | 0.80 | 1M |
| openai-compat:gpt-oss | 0.70 | 0.70 | 0.70 | 0.70 | 0.70 | model-reported |
| openai-compat:local (llama.cpp/Ollama) | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | model-reported |

The flat 0.50 for arbitrary local models is deliberate. THP has no prior
on an endpoint it's never seen before, so it shouldn't pretend to.

### 3.2 Hard filter (only survivors move on to scoring)

A candidate gets eliminated, with a stated reason, if any of these hold:

1. No credentials configured for that provider (no key in SecretStorage,
   or in the environment for the CLI).
2. Estimated required tokens — body plus resolved `contextGlobs` plus
   fixed overhead — exceed `contextWindowTokens`.
3. `expects: artifact`, or a tool-driven diff strategy, needs
   `supportsTools` and the profile says `false`.
4. `expects: message` needs structured output and
   `supportsStructuredOutput` is `false`.
5. `estimate(spec).usd` exceeds the resolved `budget.maxUsd`, or
   `estimate(spec).expectedLatencyMs` exceeds `budget.maxLatencyMs` —
   unless `pinnedProvider` names this exact candidate, in which case it
   survives but gets flagged `overBudget: true`, and the dispatch needs
   an explicit `--force` (CLI) or a confirmation dialog (VS Code) before
   it's allowed to actually spend past the ceiling. Pinning picks the
   provider; it doesn't quietly turn off the safety ceiling.

### 3.3 Scoring function

For every surviving candidate:

```
score = w_cost'      * normCost
      + w_latency'    * normLatency
      + w_success'    * successRate
      + w_affinity'   * affinity
```

- `normCost = 1 − estimate.usd / costCeiling`, clamped to [0,1], where
  `costCeiling = min(resolved budget.maxUsd, max estimate.usd among
  survivors)`. This avoids a division by zero when no budget is
  configured, and stops the cheapest survivor from automatically scoring
  a perfect 1.0 in a field where every candidate is already expensive.
- `normLatency` — the same shape, using `expectedLatencyMs`.
- `affinity` = `taskTypeAffinity[spec.taskType] ?? 0.5`. An unrecognized
  task type reads as neutral, not zero — it shouldn't look like a
  disqualification.
- `successRate` is the Laplace-smoothed historical pass rate for this
  (provider, taskType) pair, pulled from the telemetry store:
  `(successes + 1) / (attempts + 2)`. With zero attempts that's exactly
  0.5 — the "no information" prior — for every candidate equally, so it
  contributes nothing discriminative until there's real data. That's the
  whole reason for Laplace smoothing over a plain 0/1 default: a 0
  default would punish every untested provider, and a 1 default would
  let a single lucky success dominate.

Default weights: `w_cost = 0.25`, `w_latency = 0.20`, `w_success = 0.35`,
`w_affinity = 0.20`, configurable in `.thp/config.json` under
`router.weights`. Success rate carries the largest weight *at full
confidence* because it's ground truth for this codebase and this task
type — more reliable than a static affinity guess. But "full confidence"
isn't the default state; that's what cold start handles.

### 3.4 Cold start — confidence-scaled weight redistribution

Laplace smoothing on its own isn't quite enough. After exactly one
recorded attempt, one provider's smoothed rate jumps to 0.667 while every
untested provider is still sitting at 0.5 — which lets a single data
point swing 35% of the score before there's any real signal behind it. To
fix that, the weight on the success-rate term itself scales with sample
size, and whatever weight that frees up gets redistributed proportionally
across the other three terms, so the weights always sum to 1:

```
confidence   = min(1, attempts / N0)        // N0 = 5, configurable
w_success'   = w_success * confidence
leftover     = w_success − w_success'
w_cost'      = w_cost     + leftover * w_cost     / (w_cost + w_latency + w_affinity)
w_latency'   = w_latency  + leftover * w_latency  / (w_cost + w_latency + w_affinity)
w_affinity'  = w_affinity + leftover * w_affinity / (w_cost + w_latency + w_affinity)
```

Worked example with `N0 = 5` and zero attempts for every candidate on
this task type: `confidence = 0`, so `w_success' = 0` and the whole 0.35
gets redistributed across cost/latency/affinity in their existing
0.25:0.20:0.20 ratio, giving `w_cost' ≈ 0.385`, `w_latency' ≈ 0.308`,
`w_affinity' ≈ 0.308`. The router ends up, correctly, purely
cost/latency/affinity-driven on a brand-new workspace. Once a given
(provider, taskType) pair hits 5 attempts, `confidence = 1` and that
pair's score uses the full shipped weights. Every pair scales
independently — confidence is per-pair, not global — so a workspace
that's dispatched 50 `bugfix` tasks but zero `docs` tasks is still
cold-start for `docs`.

### 3.5 Fallback chain

`router.route(spec)` returns an ordered list of scored candidates, not a
single winner. The dispatch orchestrator — living in `core`, called
identically by `cli` and `vscode` — tries them in order:

- It advances to the next candidate on an adapter error (a thrown
  exception, a timeout, a non-2xx response) or on an acceptance-check
  failure.
- The budget ceiling applies cumulatively across the whole chain: a spec
  with `maxUsd: 0.50` can't spend $0.50 four separate times by falling
  through four providers. Each attempt's actual cost is subtracted from
  what's left before the next candidate is tried, and if nothing
  remaining fits the leftover budget, the chain stops and the envelope
  comes back failed with `reason: "budget exhausted"`.
- Every attempt — including the failed ones — gets recorded in the
  envelope's `attempts: DispatchAttempt[]` and written to telemetry. A
  failed fallback attempt is exactly the kind of data point the
  success-rate term needs to learn from.

### 3.6 `explain(spec)`

Returns the full breakdown as data, eliminated candidates included, along
with why each one was eliminated:

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

This is what the VS Code webview renders as a plain table (no colored
cell fills, per your spec) and what `thp explain` prints as text — same
underlying data, two renderers, no logic duplicated between them.

---

## 4. Risks — three most likely ways this ships broken

**1. `better-sqlite3` breaks packaging on some platform, architecture, or
consumer.** Native modules need a prebuilt binary matching the exact
OS/arch and Node or Electron ABI they're running under, and this one is
loaded from three of the four target surfaces at once — the VS Code
extension host, the CLI under whatever Node a user or CI box happens to
have, and transitively Antigravity/Cursor/Windsurf as VS Code forks with
their own bundled runtimes. "Works on the maintainer's Mac, breaks on
Windows or Linux ARM CI" is probably the single most common way
native-dependent VS Code extensions fail in the wild, and it lands
squarely on the surfaces this whole project is betting on. The fix is to
wrap the telemetry layer's native-module load in a try/catch at startup,
so a failed load degrades to an in-memory-only store with one clear
diagnostic rather than a crashed activation; look at shipping prebuilt
binaries for the common platform/arch combinations; and keep
`TelemetryStore` behind an interface so a pure-JS fallback — or Node's
own still-experimental `node:sqlite` on newer runtimes — is a contained
swap later rather than a rewrite.

**2. The capability matrix's cost and affinity numbers go stale, and the
router keeps looking authoritative while being wrong.** Provider pricing
and model line-ups change often, a hardcoded table will drift from
reality, and because `explain()` presents everything in a clean table,
people are more likely to trust a wrong number than they would a vague
one — which is worse than the router just looking approximate. The fix:
every `CapabilityProfile` carries an `asOf` date that shows up in the
explain view; the config lives in an easily-editable workspace JSON file
rather than buried in compiled code, so updating pricing doesn't need a
new release; and there's no promise of live-fetched pricing in v1, since
that would just trade one staleness problem for a new
external-dependency failure mode.

**3. Running the `acceptance` command is a real code-execution surface,
and doing it naively makes things worse, not better.** A `.thp.md` file
can carry an arbitrary shell command, and the thing it's being checked
against might have just been rewritten by an AI provider — a spec pulled
from a shared repo, or a provider that picks up prompt-injected
instructions from `contextGlobs` content, both turn "run the acceptance
command" into attacker-influenced code execution if it's handled
carelessly. The specific failure mode to avoid is applying an
AI-produced diff straight to the real working tree and only then running
acceptance against it — by the time acceptance reports a failure,
whatever the diff did has already happened. So: verify diffs in a
scratch worktree or temp checkout, never the live working tree, and only
fast-forward into the real tree on a pass (or with explicit confirmation
on failure); run the acceptance subprocess with a stripped environment
(no inherited provider API keys or unrelated secrets), a hard timeout,
and a working-directory jail; and require explicit confirmation the
first time a given acceptance command is seen, or whenever it changes —
the same trust-on-first-use model editors already use for workspace
tasks.

---

## Summary of decisions that differ from or add to your proposal

1. Kept your 4-package layout; explicitly rejected a `config` or `types`
   package as unnecessary indirection.
2. Made `id` optional (default: filename slug) instead of required.
3. Made `acceptance` optional with a distinct `"skipped"` verification
   status, instead of required — this is the biggest deviation, and the
   one most worth pushing back on if you disagree.
4. Added an `expects: diff | artifact | message` field, needed for the
   structured-output hard filter Phase 1.3 already asks for.
5. Rejected `title`, `status`, `retries`, `dependencies` as spec fields.
6. Specified cold start as two mechanisms — a Laplace-smoothed point
   estimate plus confidence-scaled weight redistribution — not one.

This is where the plan stood at approval. What actually got built in
Phase 1 follows it closely; the couple of places implementation forced a
small correction (dropping `composite: true`, for one) are noted inline
above rather than hidden.

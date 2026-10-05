# Task: Task Handoff Protocol (THP)

## What this is

THP is an open-source extension (VS Code/Antigravity/Cursor/Windsurf,
plus a CLI) that takes a task written as a portable spec file
(`*.thp.md`) and routes it to whichever AI backend is the best fit for
that specific task — instead of hardcoding one provider per workspace.

## The problem

Every editor AI integration today picks one backend and sticks with it.
But no single model/provider is best at everything: one is cheaper, one
is faster, one is better at a given task type, one has a bigger context
window. Developers end up manually switching tools per task, with no
record of which backend actually worked for which kind of problem in
their own codebase.

## The approach

1. **A portable spec format, not a prompt.** A task is written once as
   a `.thp.md` file — YAML frontmatter (task type, context files,
   acceptance check, budget, constraints) plus a markdown body for
   human intent. It's a file in the repo, not a message in a chat
   window, so it's reviewable, diffable, and reusable across backends.
2. **A routing engine, not a static config.** Given a spec, the router:
   - hard-filters out providers that can't actually do the job (no
     credentials, context window too small, can't produce the
     requested output shape, or busts the budget),
   - scores survivors on cost, latency, historical success rate, and a
     hand-curated task-type affinity,
   - starts purely cost/latency/affinity-driven on a brand-new
     workspace and leans on real success-rate data once enough
     attempts exist for a given (provider, task type) pair — see
     "cold start" in `docs/DESIGN.md` §3.4.
   - returns a ranked fallback chain, not just one winner, so a failed
     attempt tries the next-best candidate instead of just failing.
3. **Verify before trusting.** A diff is applied in a scratch git
   worktree and checked against the spec's `acceptance` command before
   it ever touches the real working tree — a dispatch that produces a
   diff but fails acceptance is a failure, not a partial success.
4. **One engine, several thin shells.** The routing/parsing/verification
   logic lives in `packages/core` with zero `vscode` imports. The VS
   Code extension, the CLI, and (implicitly) any future surface are all
   thin adapters on top of the same engine — same scoring, same
   fallback behavior, same telemetry, everywhere.

## Scope

| Package | Responsibility | Status |
|---|---|---|
| `@thp/schema` | JSON Schema for the `.thp.md` format | Done |
| `@thp/core` | Spec parser, provider adapters (Anthropic/Gemini/OpenAI-compatible), router, result envelope + scratch-worktree verification, telemetry store | Done |
| `@thp/cli` | Headless dispatcher: `thp route`, `thp explain`, `thp run`, JSON/table output, exit codes | Not started (Phase 3) |
| `@thp/vscode` | Commands, tree view, webview explain table, status bar, SecretStorage, Antigravity capability probe | Not started (Phase 2) |

## Non-goals

- No constraint DSL — `constraints` is free text injected into the
  prompt, not a rules engine.
- No spec-graph / task dependencies between `.thp.md` files.
- No live-fetched provider pricing in v1 — the capability matrix is a
  workspace-editable JSON file with an `asOf` date, not a service call.
- No silent cost overruns — pinning a provider past the budget ceiling
  always requires explicit confirmation (`--force` in the CLI, a dialog
  in VS Code), never a quiet bypass.

## Where to go deeper

- [`docs/DESIGN.md`](docs/DESIGN.md) — full rationale: every spec
  field's default and why, the capability matrix, the scoring formula,
  the cold-start math, and the three biggest ship-broken risks.
- [`README.md`](README.md) — repo layout, build/test/lint commands.
- [`examples/fix-flaky-retry-test.thp.md`](examples/fix-flaky-retry-test.thp.md) —
  a realistic spec file.

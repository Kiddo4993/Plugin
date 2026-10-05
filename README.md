# THP — Task Handoff Protocol

THP routes a portable task spec (`*.thp.md`) to whichever AI backend —
Anthropic, Gemini, or an OpenAI-compatible endpoint (including local
llama.cpp/Ollama) — best fits the task, based on cost, latency, historical
success rate, and task-type affinity. The routing engine is headless and
has zero `vscode` imports, so the same logic can sit under an editor
extension, a CLI, or CI.

Full design rationale (spec format, capability matrix, scoring function,
cold-start math, and the biggest ship-broken risks) is in
[`docs/DESIGN.md`](docs/DESIGN.md).

## Status

| Package | Status |
|---|---|
| [`@thp/schema`](packages/schema) | Done — JSON Schema for `.thp.md` |
| [`@thp/core`](packages/core) | Done — spec parser, provider adapters, router, result envelope + scratch-worktree acceptance verification, SQLite/in-memory telemetry store |
| [`@thp/cli`](packages/cli) | Not started (Phase 3) — placeholder package |
| [`@thp/vscode`](packages/vscode) | Not started (Phase 2) — placeholder package |

`@thp/core`'s test suite is green and lint/typecheck/build are clean at the
workspace root.

## The `.thp.md` spec format

YAML frontmatter for machine-readable fields, a markdown body for human
intent. Only `taskType` is required.

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

See [`examples/fix-flaky-retry-test.thp.md`](examples/fix-flaky-retry-test.thp.md)
for this file in full, and §2 of the design doc for every field's defaults
and rationale.

## Repo layout

```
thp/
├── docs/DESIGN.md         # design rationale, approved at Phase 0
├── examples/              # example .thp.md specs (not a package)
├── packages/
│   ├── schema/             # @thp/schema — JSON Schema for the spec format
│   ├── core/                # @thp/core — headless routing engine (no vscode imports)
│   ├── cli/                   # @thp/cli — headless dispatcher (bin: thp) — Phase 3
│   └── vscode/              # @thp/vscode — editor extension host adapter — Phase 2
├── pnpm-workspace.yaml
└── package.json
```

## Getting started

Requires Node >= 20 and pnpm (via corepack). `better-sqlite3` is an
optional dependency of `@thp/core`; if its native build fails on your
machine, telemetry falls back to an in-memory store automatically.

```bash
pnpm install
pnpm run build       # builds all packages that have a build script
pnpm run test        # runs @thp/core's vitest suite
pnpm run lint
pnpm run typecheck
```

To work on `@thp/core` directly:

```bash
cd packages/core
pnpm run test:watch
```

## License

MIT (per package manifests). No root `LICENSE` file has been added yet.

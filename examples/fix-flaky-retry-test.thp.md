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

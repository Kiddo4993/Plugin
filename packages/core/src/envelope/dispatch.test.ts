import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "../router/router.js";
import { InMemoryTelemetryStore } from "../telemetry/store.js";
import { dispatchWithFallback } from "./dispatch.js";
import { makeDispatchCtx, makeDispatchSpec, ScriptedProvider } from "./test-helpers.js";

describe("dispatchWithFallback", () => {
  let dir: string;

  beforeEach(() => {
    // A plain (non-git) temp dir — acceptance verification falls back to
    // running directly against it rather than a scratch worktree, which
    // is exactly what most of these tests want: no diff materialization,
    // just orchestration plumbing.
    dir = mkdtempSync(path.join(tmpdir(), "thp-dispatch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes on the first provider and records one telemetry entry", async () => {
    const provider = new ScriptedProvider({
      providerId: "anthropic",
      events: [
        { type: "token", text: "diff --git a/x b/x" },
        { type: "usage", inputTokens: 10, outputTokens: 5 },
        { type: "done" },
      ],
    });
    const telemetry = new InMemoryTelemetryStore();
    const router = new Router([provider], telemetry);
    const spec = makeDispatchSpec({ acceptance: 'node -e "process.exit(0)"' });

    const envelope = await dispatchWithFallback(spec, router, makeDispatchCtx({ workspaceRoot: dir }), telemetry);

    expect(envelope.finalStatus).toBe("passed");
    expect(envelope.chosenAttemptIndex).toBe(0);
    expect(envelope.attempts).toHaveLength(1);
    expect(envelope.attempts[0]?.diff).toBe("diff --git a/x b/x");
    expect(envelope.attempts[0]?.providerId).toBe("anthropic");
    expect(telemetry.getStats("anthropic", "default", "bugfix")).toEqual({ attempts: 1, successes: 1 });
  });

  it("falls back to the second provider when the first errors", async () => {
    const failing = new ScriptedProvider({
      providerId: "flaky",
      estimateUsd: 0.001,
      events: [{ type: "error", message: "rate limited", retryable: true }],
    });
    const working = new ScriptedProvider({
      providerId: "reliable",
      estimateUsd: 0.002,
      events: [
        { type: "token", text: "diff --git a/x b/x" },
        { type: "usage", inputTokens: 1, outputTokens: 1 },
        { type: "done" },
      ],
    });
    const telemetry = new InMemoryTelemetryStore();
    const router = new Router([failing, working], telemetry);
    const spec = makeDispatchSpec({ acceptance: 'node -e "process.exit(0)"' });

    const envelope = await dispatchWithFallback(spec, router, makeDispatchCtx({ workspaceRoot: dir }), telemetry);

    expect(envelope.attempts).toHaveLength(2);
    expect(envelope.attempts[0]?.providerId).toBe("flaky");
    expect(envelope.attempts[0]?.acceptance.status).toBe("failed");
    expect(envelope.attempts[1]?.providerId).toBe("reliable");
    expect(envelope.chosenAttemptIndex).toBe(1);
    expect(envelope.finalStatus).toBe("passed");
  });

  it("marks a dispatch with no acceptance command as skipped, not passed", async () => {
    const provider = new ScriptedProvider({
      providerId: "anthropic",
      events: [
        { type: "token", text: "diff --git a/x b/x" },
        { type: "usage", inputTokens: 1, outputTokens: 1 },
        { type: "done" },
      ],
    });
    const telemetry = new InMemoryTelemetryStore();
    const router = new Router([provider], telemetry);
    const spec = makeDispatchSpec(); // no `acceptance` field

    const envelope = await dispatchWithFallback(spec, router, makeDispatchCtx({ workspaceRoot: dir }), telemetry);

    expect(envelope.finalStatus).toBe("skipped");
    expect(envelope.attempts[0]?.acceptance).toEqual({
      status: "skipped",
      reason: "spec has no acceptance command configured",
    });
  });

  it("stores 'message' output as an artifact, not a diff", async () => {
    const provider = new ScriptedProvider({
      providerId: "anthropic",
      events: [
        { type: "token", text: "Here is an explanation." },
        { type: "usage", inputTokens: 1, outputTokens: 1 },
        { type: "done" },
      ],
    });
    const telemetry = new InMemoryTelemetryStore();
    const router = new Router([provider], telemetry);
    const spec = makeDispatchSpec({ expects: "message" });

    const envelope = await dispatchWithFallback(spec, router, makeDispatchCtx({ workspaceRoot: dir }), telemetry);

    expect(envelope.attempts[0]?.diff).toBeUndefined();
    expect(envelope.attempts[0]?.artifacts).toEqual([
      { name: "response.md", mimeType: "text/markdown", content: "Here is an explanation." },
    ]);
  });

  it("reports failure with a clear stopReason when no providers survive routing", async () => {
    const telemetry = new InMemoryTelemetryStore();
    const router = new Router([], telemetry);
    const spec = makeDispatchSpec();

    const envelope = await dispatchWithFallback(spec, router, makeDispatchCtx({ workspaceRoot: dir }), telemetry);

    expect(envelope.finalStatus).toBe("failed");
    expect(envelope.attempts).toEqual([]);
    expect(envelope.stopReason).toMatch(/no providers survived routing/);
  });

  it("stops the chain when cumulative actual spend exhausts the budget, even if per-candidate estimates were within it", async () => {
    const pricey = new ScriptedProvider({
      providerId: "first",
      estimateUsd: 0.001, // looks cheap up front...
      inputCostPerMTok: 1000, // ...but its real usage is expensive: 8 tokens * $1000/M = $0.008
      events: [
        { type: "usage", inputTokens: 8, outputTokens: 0 },
        { type: "error", message: "boom", retryable: false },
      ],
    });
    const second = new ScriptedProvider({
      providerId: "second",
      estimateUsd: 0.005, // within the $0.01 spec budget, but not within what's left after `first`
      events: [{ type: "token", text: "diff" }, { type: "usage", inputTokens: 0, outputTokens: 0 }, { type: "done" }],
    });
    const telemetry = new InMemoryTelemetryStore();
    const router = new Router([pricey, second], telemetry);
    const spec = makeDispatchSpec({ budget: { maxUsd: 0.01 } });

    const envelope = await dispatchWithFallback(spec, router, makeDispatchCtx({ workspaceRoot: dir }), telemetry);

    expect(envelope.attempts).toHaveLength(1);
    expect(envelope.attempts[0]?.providerId).toBe("first");
    expect(envelope.totalUsdSpent).toBeCloseTo(0.008, 6);
    expect(envelope.stopReason).toMatch(/budget exhausted/);
    expect(envelope.finalStatus).toBe("failed");
  });
});

import { describe, expect, it } from "vitest";
import { InMemoryTelemetryStore } from "../telemetry/store.js";
import { DEFAULT_WEIGHTS, Router } from "./router.js";
import { FakeProvider, makeRouterSpec } from "./test-helpers.js";

describe("Router — hard filters", () => {
  it("eliminates a provider whose context window is too small", () => {
    const small = new FakeProvider({ providerId: "small", contextWindowTokens: 1 });
    const big = new FakeProvider({ providerId: "big", contextWindowTokens: 100_000 });
    const router = new Router([small, big], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec({ body: "x".repeat(4000) }));

    const smallCandidate = explanation.candidates.find((c) => c.providerId === "small");
    expect(smallCandidate?.eliminated).toBe(true);
    expect(smallCandidate?.eliminationReason).toMatch(/context window/);
  });

  it("eliminates a provider without tool support when the spec expects a diff", () => {
    const noTools = new FakeProvider({ providerId: "no-tools", supportsTools: false });
    const router = new Router([noTools], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec({ expects: "diff" }));

    expect(explanation.candidates[0]?.eliminated).toBe(true);
    expect(explanation.candidates[0]?.eliminationReason).toMatch(/tool support/);
  });

  it("eliminates a provider without structured output when the spec expects a message", () => {
    const noStructured = new FakeProvider({ providerId: "no-structured", supportsStructuredOutput: false });
    const router = new Router([noStructured], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec({ expects: "message" }));

    expect(explanation.candidates[0]?.eliminated).toBe(true);
    expect(explanation.candidates[0]?.eliminationReason).toMatch(/structured/);
  });

  it("eliminates a non-pinned provider that exceeds the budget ceiling", () => {
    const expensive = new FakeProvider({ providerId: "expensive", usd: 5 });
    const router = new Router([expensive], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec({ budget: { maxUsd: 1 } }));

    expect(explanation.candidates[0]?.eliminated).toBe(true);
    expect(explanation.candidates[0]?.eliminationReason).toMatch(/budget/);
  });
});

describe("Router — cold start scoring", () => {
  it("falls back to pure cost/latency/affinity when no telemetry exists, per docs/DESIGN.md §3.4", () => {
    const a = new FakeProvider({
      providerId: "provider-a",
      taskTypeAffinity: { bugfix: 0.5 },
      usd: 0.001,
      expectedLatencyMs: 500,
    });
    const b = new FakeProvider({
      providerId: "provider-b",
      taskTypeAffinity: { bugfix: 1.0 },
      usd: 0.002,
      expectedLatencyMs: 1000,
    });
    const router = new Router([a, b], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec());
    const byProvider = Object.fromEntries(explanation.candidates.map((c) => [c.providerId, c]));

    // Both are cold: success-rate weight is fully redistributed to cost/latency/affinity.
    expect(byProvider["provider-a"]?.successRate.confidence).toBe(0);
    expect(byProvider["provider-b"]?.successRate.confidence).toBe(0);

    // Hand-computed per docs/DESIGN.md §3.4: costCeiling=0.002, latencyCeiling=1000.
    // provider-a: normCost=0.5, normLatency=0.5, affinity=0.5 → score = 0.5 (all three terms agree).
    // provider-b: normCost=0, normLatency=0, affinity=1.0 → score = redistributed affinity weight ≈ 0.3077.
    expect(byProvider["provider-a"]?.score).toBeCloseTo(0.5, 4);
    expect(byProvider["provider-b"]?.score).toBeCloseTo(0.3077, 3);

    // Cheaper/faster wins at cold start even with half the affinity.
    expect(explanation.candidates[0]?.providerId).toBe("provider-a");
    expect(explanation.candidates[0]?.rank).toBe(1);
    expect(explanation.candidates[1]?.providerId).toBe("provider-b");
    expect(explanation.candidates[1]?.rank).toBe(2);
  });

  it("lets a warmed-up success rate overtake a cold cost/latency advantage", () => {
    const a = new FakeProvider({
      providerId: "provider-a",
      taskTypeAffinity: { bugfix: 0.5 },
      usd: 0.001,
      expectedLatencyMs: 500,
    });
    const b = new FakeProvider({
      providerId: "provider-b",
      taskTypeAffinity: { bugfix: 1.0 },
      usd: 0.002,
      expectedLatencyMs: 1000,
    });
    const telemetry = new InMemoryTelemetryStore();
    for (let i = 0; i < 10; i++) {
      telemetry.recordAttempt({
        specId: `s${i}`,
        taskType: "bugfix",
        providerId: "provider-b",
        modelId: "default",
        usd: 0.002,
        latencyMs: 1000,
        acceptance: "passed",
        timestamp: new Date().toISOString(),
      });
    }
    const router = new Router([a, b], telemetry, { coldStartThreshold: 5 });

    const explanation = router.explain(makeRouterSpec());
    const byProvider = Object.fromEntries(explanation.candidates.map((c) => [c.providerId, c]));

    expect(byProvider["provider-b"]?.successRate).toEqual({
      attempts: 10,
      successes: 10,
      smoothed: 11 / 12,
      confidence: 1,
    });
    // provider-a is untouched and still cold — its score is unchanged from the cold-start test.
    expect(byProvider["provider-a"]?.score).toBeCloseTo(0.5, 4);
    // provider-b is now fully warm: score = 0.35*(11/12) + 0.20*1.0 ≈ 0.5208.
    expect(byProvider["provider-b"]?.score).toBeCloseTo(0.5208, 3);

    expect(explanation.candidates[0]?.providerId).toBe("provider-b");
  });

  it("treats an unrecognized taskType as a neutral 0.5 affinity, not a penalty", () => {
    const provider = new FakeProvider({ providerId: "p", taskTypeAffinity: { bugfix: 0.9 } });
    const router = new Router([provider], new InMemoryTelemetryStore());
    const explanation = router.explain(makeRouterSpec({ taskType: "some-new-task-type" }));
    expect(explanation.candidates[0]?.affinity).toBe(0.5);
  });
});

describe("Router — pinning", () => {
  it("promotes a pinned provider to rank 1 even when it would otherwise score lower", () => {
    const cheap = new FakeProvider({ providerId: "cheap", usd: 0.001, expectedLatencyMs: 100 });
    const pinnedTarget = new FakeProvider({ providerId: "pinned", usd: 0.5, expectedLatencyMs: 5000 });
    const router = new Router([cheap, pinnedTarget], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec({ pinnedProvider: "pinned" }));

    expect(explanation.candidates[0]?.providerId).toBe("pinned");
    expect(explanation.candidates[0]?.rank).toBe(1);
  });

  it("matches provider:model pins on both segments", () => {
    const v1 = new FakeProvider({ providerId: "acme", modelId: "v1" });
    const v2 = new FakeProvider({ providerId: "acme", modelId: "v2" });
    const router = new Router([v1, v2], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec({ pinnedProvider: "acme:v2" }));

    expect(explanation.candidates[0]?.modelId).toBe("v2");
  });

  it("keeps an over-budget pin in explain() but excludes it from route() without forceOverBudget", () => {
    const pinnedTarget = new FakeProvider({ providerId: "pinned", usd: 5 });
    const router = new Router([pinnedTarget], new InMemoryTelemetryStore());
    const spec = makeRouterSpec({ pinnedProvider: "pinned", budget: { maxUsd: 1 } });

    const explanation = router.explain(spec);
    expect(explanation.candidates[0]).toMatchObject({
      providerId: "pinned",
      eliminated: false,
      overBudget: true,
    });

    expect(router.route(spec)).toEqual([]);
    expect(router.route(spec, { forceOverBudget: true })).toHaveLength(1);
  });

  it("does not honor a pin the provider's capabilities can't satisfy", () => {
    const noTools = new FakeProvider({ providerId: "pinned", supportsTools: false });
    const router = new Router([noTools], new InMemoryTelemetryStore());

    const explanation = router.explain(makeRouterSpec({ pinnedProvider: "pinned", expects: "diff" }));

    expect(explanation.candidates[0]).toMatchObject({ providerId: "pinned", eliminated: true });
  });
});

describe("Router — route()", () => {
  it("returns Provider instances in the same order as explain()'s surviving candidates", () => {
    const a = new FakeProvider({ providerId: "a", usd: 0.001 });
    const b = new FakeProvider({ providerId: "b", usd: 0.002 });
    const router = new Router([a, b], new InMemoryTelemetryStore());

    const chain = router.route(makeRouterSpec());
    const explanation = router.explain(makeRouterSpec());
    const survivorIds = explanation.candidates.filter((c) => !c.eliminated).map((c) => c.providerId);

    expect(chain.map((p) => p.id)).toEqual(survivorIds);
  });

  it("omits eliminated providers from the chain entirely", () => {
    const tiny = new FakeProvider({ providerId: "tiny", contextWindowTokens: 1 });
    const router = new Router([tiny], new InMemoryTelemetryStore());
    expect(router.route(makeRouterSpec({ body: "x".repeat(4000) }))).toEqual([]);
  });

  it("uses DEFAULT_WEIGHTS by default and lets them be overridden", () => {
    const a = new FakeProvider({ providerId: "a" });
    const router = new Router([a], new InMemoryTelemetryStore());
    expect(router.explain(makeRouterSpec()).weights).toEqual(DEFAULT_WEIGHTS);

    const customized = new Router([a], new InMemoryTelemetryStore(), {
      weights: { cost: 1, latency: 0, successRate: 0, affinity: 0 },
    });
    expect(customized.explain(makeRouterSpec()).weights).toEqual({
      cost: 1,
      latency: 0,
      successRate: 0,
      affinity: 0,
    });
  });
});

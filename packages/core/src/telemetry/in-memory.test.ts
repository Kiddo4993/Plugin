import { describe, expect, it } from "vitest";
import type { TelemetryRecord } from "../types.js";
import { InMemoryTelemetryStore } from "./store.js";

function record(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    specId: "spec-1",
    taskType: "bugfix",
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    usd: 0.01,
    latencyMs: 1000,
    acceptance: "passed",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("InMemoryTelemetryStore", () => {
  it("returns zero attempts for a pair it has never seen", () => {
    const store = new InMemoryTelemetryStore();
    expect(store.getStats("anthropic", "claude-sonnet-5", "bugfix")).toEqual({
      attempts: 0,
      successes: 0,
    });
  });

  it("counts attempts and successes scoped to (providerId, modelId, taskType)", () => {
    const store = new InMemoryTelemetryStore();
    store.recordAttempt(record({ acceptance: "passed" }));
    store.recordAttempt(record({ acceptance: "failed" }));
    store.recordAttempt(record({ acceptance: "passed" }));
    // different taskType — must not be counted
    store.recordAttempt(record({ taskType: "docs", acceptance: "passed" }));
    // different provider — must not be counted
    store.recordAttempt(record({ providerId: "google", acceptance: "passed" }));

    expect(store.getStats("anthropic", "claude-sonnet-5", "bugfix")).toEqual({
      attempts: 3,
      successes: 2,
    });
  });

  it("does not count a 'skipped' acceptance as a success", () => {
    const store = new InMemoryTelemetryStore();
    store.recordAttempt(record({ acceptance: "skipped" }));
    expect(store.getStats("anthropic", "claude-sonnet-5", "bugfix")).toEqual({
      attempts: 1,
      successes: 0,
    });
  });

  it("allRecords returns everything recorded, and is a defensive copy", () => {
    const store = new InMemoryTelemetryStore();
    store.recordAttempt(record());
    const all = store.allRecords();
    expect(all).toHaveLength(1);
    all.push(record());
    expect(store.allRecords()).toHaveLength(1);
  });
});

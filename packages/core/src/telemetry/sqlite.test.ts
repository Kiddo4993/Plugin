import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelemetryRecord, TelemetryStore } from "../types.js";
import { openTelemetryStore } from "./store.js";

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

describe("openTelemetryStore (SQLite-backed)", () => {
  let dir: string;
  let dbPath: string;
  let store: TelemetryStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "thp-telemetry-"));
    dbPath = path.join(dir, "telemetry.sqlite");
    store = await openTelemetryStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a recorded attempt through getStats", () => {
    store.recordAttempt(record({ acceptance: "passed" }));
    store.recordAttempt(record({ acceptance: "failed" }));

    expect(store.getStats("anthropic", "claude-sonnet-5", "bugfix")).toEqual({
      attempts: 2,
      successes: 1,
    });
  });

  it("persists to disk: a second store opened on the same path sees prior attempts", async () => {
    store.recordAttempt(record({ acceptance: "passed" }));
    store.close();

    const reopened = await openTelemetryStore(dbPath);
    try {
      expect(reopened.getStats("anthropic", "claude-sonnet-5", "bugfix")).toEqual({
        attempts: 1,
        successes: 1,
      });
    } finally {
      reopened.close();
    }
  });

  it("allRecords returns every attempt in timestamp order", () => {
    store.recordAttempt(record({ specId: "a", timestamp: "2026-01-01T00:00:00.000Z" }));
    store.recordAttempt(record({ specId: "b", timestamp: "2026-01-02T00:00:00.000Z" }));
    const all = store.allRecords();
    expect(all.map((r) => r.specId)).toEqual(["a", "b"]);
  });
});

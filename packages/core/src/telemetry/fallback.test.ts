import { describe, expect, it, vi } from "vitest";
import { InMemoryTelemetryStore } from "./store.js";

// Simulates a native-module load failure (docs/DESIGN.md risk #1): the
// dynamic `import("better-sqlite3")` inside openTelemetryStore() must be
// caught, not crash the caller, and must degrade to an in-memory store.
vi.mock("better-sqlite3", () => {
  throw new Error("simulated native binding load failure");
});

describe("openTelemetryStore fallback", () => {
  it("degrades to an in-memory store with one diagnostic instead of throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { openTelemetryStore } = await import("./store.js");

    const store = await openTelemetryStore("/does/not/matter.sqlite");

    expect(store).toBeInstanceOf(InMemoryTelemetryStore);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("falling back to an in-memory-only telemetry store");

    store.recordAttempt({
      specId: "s",
      taskType: "bugfix",
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
      usd: 0,
      latencyMs: 0,
      acceptance: "passed",
      timestamp: new Date().toISOString(),
    });
    expect(store.getStats("anthropic", "claude-sonnet-5", "bugfix").attempts).toBe(1);

    warnSpy.mockRestore();
  });
});

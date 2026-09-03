import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaceConfig, resolveRouterOptions, telemetryDbPath } from "./config.js";
import { DEFAULT_COLD_START_THRESHOLD, DEFAULT_WEIGHTS, HARD_FALLBACK_BUDGET } from "./router/router.js";

describe("loadWorkspaceConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "thp-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns {} when .thp/config.json does not exist", async () => {
    expect(await loadWorkspaceConfig(dir)).toEqual({});
  });

  it("parses an existing config.json", async () => {
    await mkdir(path.join(dir, ".thp"), { recursive: true });
    await writeFile(
      path.join(dir, ".thp", "config.json"),
      JSON.stringify({ budget: { maxUsd: 2 } }),
    );
    expect(await loadWorkspaceConfig(dir)).toEqual({ budget: { maxUsd: 2 } });
  });

  it("throws a clear error on malformed JSON rather than silently ignoring it", async () => {
    await mkdir(path.join(dir, ".thp"), { recursive: true });
    await writeFile(path.join(dir, ".thp", "config.json"), "{ not valid json");
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/failed to parse/);
  });
});

describe("resolveRouterOptions", () => {
  it("uses every hardcoded default when the workspace config is empty", () => {
    const options = resolveRouterOptions({});
    expect(options.weights).toEqual(DEFAULT_WEIGHTS);
    expect(options.coldStartThreshold).toBe(DEFAULT_COLD_START_THRESHOLD);
    expect(options.fallbackBudget).toEqual(HARD_FALLBACK_BUDGET);
  });

  it("overlays partial workspace config over the defaults", () => {
    const options = resolveRouterOptions({
      router: { weights: { cost: 0.9 }, coldStartThreshold: 10 },
      budget: { maxUsd: 3 },
    });
    expect(options.weights).toEqual({ ...DEFAULT_WEIGHTS, cost: 0.9 });
    expect(options.coldStartThreshold).toBe(10);
    expect(options.fallbackBudget).toEqual({ maxUsd: 3, maxLatencyMs: HARD_FALLBACK_BUDGET.maxLatencyMs });
  });
});

describe("telemetryDbPath", () => {
  it("points at .thp/telemetry.sqlite under the workspace root", () => {
    expect(telemetryDbPath("/repo")).toBe(path.join("/repo", ".thp", "telemetry.sqlite"));
  });
});

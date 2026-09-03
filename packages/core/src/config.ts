import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_COLD_START_THRESHOLD, DEFAULT_WEIGHTS, HARD_FALLBACK_BUDGET } from "./router/router.js";
import type { RouterOptions } from "./router/router.js";
import type { WorkspaceConfig } from "./types.js";

export const WORKSPACE_CONFIG_RELATIVE_PATH = path.join(".thp", "config.json");

/**
 * Loads `.thp/config.json` from a workspace root. A missing file is not an
 * error — it just means "use every default" — but a present-and-malformed
 * file is, since silently ignoring a typo'd config is worse than failing
 * loudly.
 */
export async function loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  const configPath = path.join(workspaceRoot, WORKSPACE_CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`failed to read ${configPath}: ${(err as Error).message}`, { cause: err });
  }

  try {
    return JSON.parse(raw) as WorkspaceConfig;
  } catch (err) {
    throw new Error(`failed to parse ${configPath} as JSON: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Merges workspace config over THP's hardcoded defaults into the options
 * shape Router expects. This is the one place the three-tier budget
 * resolution (spec, then workspace config, then a hardcoded floor)
 * actually happens — Router itself only ever applies the spec-level
 * override on top of whatever `fallbackBudget` it's handed here.
 */
export function resolveRouterOptions(config: WorkspaceConfig): RouterOptions {
  return {
    weights: { ...DEFAULT_WEIGHTS, ...config.router?.weights },
    coldStartThreshold: config.router?.coldStartThreshold ?? DEFAULT_COLD_START_THRESHOLD,
    fallbackBudget: {
      maxUsd: config.budget?.maxUsd ?? HARD_FALLBACK_BUDGET.maxUsd,
      maxLatencyMs: config.budget?.maxLatencyMs ?? HARD_FALLBACK_BUDGET.maxLatencyMs,
    },
  };
}

/** Workspace-local, gitignored path for the telemetry database. */
export function telemetryDbPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".thp", "telemetry.sqlite");
}

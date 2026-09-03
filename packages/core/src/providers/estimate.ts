import type { CapabilityProfile, CostEstimate, TaskSpec } from "../types.js";

/**
 * Rough cost/latency estimate from a spec alone (no filesystem access — the
 * Provider.estimate() contract takes only the spec, not a DispatchContext,
 * so unresolved contextGlobs can only be guessed at via a flat per-glob
 * token allowance). Shared across adapters: the heuristic is identical,
 * only the profile (and therefore the price) differs.
 */
/**
 * Rough required-input-token count from the spec alone, used both for cost
 * estimation (below) and for the router's context-window hard filter —
 * neither has access to resolved file contents at this point.
 */
export function estimateRequiredInputTokens(spec: TaskSpec): number {
  const bodyTokens = roughTokenCount(spec.body) + roughTokenCount(spec.constraints.join(" "));
  const unresolvedGlobAllowance = spec.contextGlobs.length * 500; // crude per-file guess, pre-resolution
  return bodyTokens + unresolvedGlobAllowance;
}

export function estimateFromProfile(profile: CapabilityProfile, spec: TaskSpec): CostEstimate {
  const estimatedInputTokens = estimateRequiredInputTokens(spec);
  const estimatedOutputTokens = Math.min(profile.maxOutputTokens, 1024);

  const usd =
    (estimatedInputTokens / 1_000_000) * profile.inputCostPerMTok +
    (estimatedOutputTokens / 1_000_000) * profile.outputCostPerMTok;

  // Crude base latency + per-output-token throughput guess. This is a
  // starting prior, not a measurement — see docs/DESIGN.md risk #2.
  const expectedLatencyMs = 1500 + estimatedOutputTokens * 15;

  return { usd, expectedLatencyMs, confidence: 0.3 };
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

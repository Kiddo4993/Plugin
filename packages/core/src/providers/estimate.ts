import type { CapabilityProfile, CostEstimate, TaskSpec } from "../types.js";

/**
 * Rough required-input-token count from the spec alone, used both for cost
 * estimation (below) and for the router's context-window hard filter.
 * Neither has access to resolved file contents at this point — a glob
 * like `src/**` is just a string until something actually reads the
 * filesystem, which estimate() never does.
 */
export function estimateRequiredInputTokens(spec: TaskSpec): number {
  const bodyTokens = roughTokenCount(spec.body) + roughTokenCount(spec.constraints.join(" "));
  const unresolvedGlobAllowance = spec.contextGlobs.length * 500; // crude per-file guess, pre-resolution
  return bodyTokens + unresolvedGlobAllowance;
}

/**
 * Rough cost/latency estimate from a spec alone. Shared across all three
 * adapters — the heuristic is identical, only the profile (and therefore
 * the price) differs between them.
 */
export function estimateFromProfile(profile: CapabilityProfile, spec: TaskSpec): CostEstimate {
  const estimatedInputTokens = estimateRequiredInputTokens(spec);
  const estimatedOutputTokens = Math.min(profile.maxOutputTokens, 1024);

  const usd =
    (estimatedInputTokens / 1_000_000) * profile.inputCostPerMTok +
    (estimatedOutputTokens / 1_000_000) * profile.outputCostPerMTok;

  // Base latency plus a per-output-token throughput guess — a starting
  // prior, not something measured against a real provider yet.
  const expectedLatencyMs = 1500 + estimatedOutputTokens * 15;

  return { usd, expectedLatencyMs, confidence: 0.3 };
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

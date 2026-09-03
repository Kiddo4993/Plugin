import type { CapabilityProfile } from "../types.js";

/**
 * Starting defaults for the capability matrix.
 *
 * IMPORTANT: the taskTypeAffinity numbers below are illustrative starting
 * priors for the router's cold-start behavior, not a benchmarked quality
 * claim. Nobody has evaluated these models against each other for this
 * project. Pricing is similarly a snapshot that will go stale; `asOf`
 * records when it was last checked. Both are meant to be overridden per
 * workspace via `.thp/config.json` as real telemetry (and real pricing
 * pages) become available.
 */
export const DEFAULT_CAPABILITY_MATRIX: readonly CapabilityProfile[] = [
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    taskTypeAffinity: {
      codegen: 0.85,
      refactor: 0.85,
      bugfix: 0.85,
      "test-gen": 0.8,
      docs: 0.75,
      explain: 0.8,
    },
    contextWindowTokens: 200_000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsStructuredOutput: true,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    asOf: "2026-09-02",
  },
  {
    providerId: "google",
    modelId: "gemini-3",
    taskTypeAffinity: {
      codegen: 0.8,
      refactor: 0.75,
      bugfix: 0.75,
      "test-gen": 0.75,
      docs: 0.8,
      explain: 0.8,
    },
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsStructuredOutput: true,
    inputCostPerMTok: 1.25,
    outputCostPerMTok: 5,
    asOf: "2026-09-02",
  },
  {
    providerId: "openai-compat",
    modelId: "gpt-oss",
    taskTypeAffinity: {
      codegen: 0.7,
      refactor: 0.7,
      bugfix: 0.7,
      "test-gen": 0.7,
      docs: 0.7,
      explain: 0.7,
    },
    contextWindowTokens: 128_000,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsStructuredOutput: false,
    inputCostPerMTok: 0.5,
    outputCostPerMTok: 1.5,
    asOf: "2026-09-02",
  },
  {
    // Placeholder profile for a self-hosted / local endpoint (llama.cpp,
    // Ollama, ...) reached through the OpenAI-compatible adapter via a
    // baseUrl override. THP has no prior on an endpoint it's never seen —
    // the flat 0.5 affinity and zero cost are deliberate, not a guess
    // dressed up as one. Workspaces should override this in
    // .thp/config.json once they know their local model's real context
    // window and quality.
    providerId: "openai-compat",
    modelId: "local",
    taskTypeAffinity: {
      codegen: 0.5,
      refactor: 0.5,
      bugfix: 0.5,
      "test-gen": 0.5,
      docs: 0.5,
      explain: 0.5,
    },
    contextWindowTokens: 32_768,
    maxOutputTokens: 4096,
    supportsTools: false,
    supportsStructuredOutput: false,
    inputCostPerMTok: 0,
    outputCostPerMTok: 0,
    asOf: "2026-09-02",
  },
] as const;

export function findDefaultProfile(providerId: string, modelId: string): CapabilityProfile | undefined {
  return DEFAULT_CAPABILITY_MATRIX.find((p) => p.providerId === providerId && p.modelId === modelId);
}

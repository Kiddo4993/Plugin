import { estimateRequiredInputTokens } from "../providers/estimate.js";
import type {
  CandidateExplanation,
  CapabilityProfile,
  CostEstimate,
  Provider,
  RouteOptions,
  RouterWeights,
  RoutingExplanation,
  SuccessRateBreakdown,
  TaskSpec,
  TelemetryStore,
} from "../types.js";

/** Success rate carries the most weight once it's trusted; cost/latency/affinity fill in until then. */
export const DEFAULT_WEIGHTS: RouterWeights = {
  cost: 0.25,
  latency: 0.2,
  successRate: 0.35,
  affinity: 0.2,
};

/** How many attempts it takes before a (provider, taskType) pair's success rate is fully trusted. */
export const DEFAULT_COLD_START_THRESHOLD = 5;

/** The safety net used only when neither the spec nor the workspace config sets a budget. */
export const HARD_FALLBACK_BUDGET = { maxUsd: 1.0, maxLatencyMs: 5 * 60 * 1000 };

export interface RouterOptions {
  weights?: RouterWeights;
  coldStartThreshold?: number;
  /**
   * The effective default budget to use when a spec sets none. Callers
   * (cli/vscode config loading) are responsible for merging workspace
   * config over HARD_FALLBACK_BUDGET before constructing the Router — the
   * router itself only ever applies one more level of override (the
   * spec's own `budget` field), never reads a config file.
   */
  fallbackBudget?: { maxUsd: number; maxLatencyMs: number };
}

interface ResolvedBudget {
  maxUsd: number;
  maxLatencyMs: number;
}

/**
 * Scores registered providers for a TaskSpec and returns an ordered
 * fallback chain. The full reasoning behind the scoring model lives in
 * docs/DESIGN.md; this class is a direct implementation of it.
 */
export class Router {
  private readonly weights: RouterWeights;
  private readonly coldStartThreshold: number;
  private readonly fallbackBudget: { maxUsd: number; maxLatencyMs: number };

  constructor(
    private readonly providers: readonly Provider[],
    private readonly telemetry: TelemetryStore,
    options: RouterOptions = {},
  ) {
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.coldStartThreshold = options.coldStartThreshold ?? DEFAULT_COLD_START_THRESHOLD;
    this.fallbackBudget = options.fallbackBudget ?? HARD_FALLBACK_BUDGET;
  }

  /**
   * Full scoring breakdown as data, including eliminated candidates and
   * why. This is the router's entire trust model: nothing route() returns
   * that isn't visible here first.
   */
  explain(spec: TaskSpec): RoutingExplanation {
    const budget = this.resolveBudget(spec);
    const [pinnedProviderId, pinnedModelId] = splitPin(spec.pinnedProvider);
    const requiredTokens = estimateRequiredInputTokens(spec);

    const eliminated: CandidateExplanation[] = [];
    const survivors: Array<{
      profile: CapabilityProfile;
      estimate: CostEstimate;
      successRate: SuccessRateBreakdown;
      affinity: number;
      overBudget: boolean;
    }> = [];

    for (const provider of this.providers) {
      const profile = provider.capabilities();
      const isPinned =
        pinnedProviderId !== undefined &&
        profile.providerId === pinnedProviderId &&
        (pinnedModelId === undefined || profile.modelId === pinnedModelId);

      const estimate = provider.estimate(spec);
      const stats = this.telemetry.getStats(profile.providerId, profile.modelId, spec.taskType);
      const successRate = computeSuccessRate(
        stats.attempts,
        stats.successes,
        this.coldStartThreshold,
      );
      const affinity = profile.taskTypeAffinity[spec.taskType] ?? 0.5;

      const filter = hardFilter(spec, profile, requiredTokens, estimate, budget, isPinned);

      if (filter.eliminated) {
        eliminated.push({
          providerId: profile.providerId,
          modelId: profile.modelId,
          eliminated: true,
          ...(filter.reason !== undefined ? { eliminationReason: filter.reason } : {}),
          estimate,
          affinity,
          successRate,
        });
        continue;
      }

      survivors.push({ profile, estimate, successRate, affinity, overBudget: filter.overBudget });
    }

    const costCeiling = Math.max(
      1e-9,
      survivors.length > 0
        ? Math.min(budget.maxUsd, Math.max(...survivors.map((s) => s.estimate.usd)))
        : budget.maxUsd,
    );
    const latencyCeiling = Math.max(
      1,
      survivors.length > 0
        ? Math.min(budget.maxLatencyMs, Math.max(...survivors.map((s) => s.estimate.expectedLatencyMs)))
        : budget.maxLatencyMs,
    );

    const scored: CandidateExplanation[] = survivors.map((s) => {
      const normCost = clamp01(1 - s.estimate.usd / costCeiling);
      const normLatency = clamp01(1 - s.estimate.expectedLatencyMs / latencyCeiling);
      const score = computeAdjustedScore(this.weights, s.successRate, normCost, normLatency, s.affinity);
      return {
        providerId: s.profile.providerId,
        modelId: s.profile.modelId,
        eliminated: false,
        ...(s.overBudget ? { overBudget: true } : {}),
        estimate: s.estimate,
        affinity: s.affinity,
        successRate: s.successRate,
        score,
      };
    });

    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // An explicit pin bypasses competitive scoring: it goes first in the
    // chain (still gated on the budget flag above), and the rest of the
    // chain keeps its normal scored order for fallback.
    if (pinnedProviderId !== undefined) {
      const pinnedIndex = scored.findIndex(
        (c) =>
          c.providerId === pinnedProviderId && (pinnedModelId === undefined || c.modelId === pinnedModelId),
      );
      if (pinnedIndex > 0) {
        const [pinned] = scored.splice(pinnedIndex, 1);
        if (pinned) {
          scored.unshift(pinned);
        }
      }
    }

    scored.forEach((c, i) => {
      c.rank = i + 1;
    });

    return {
      specId: spec.id,
      generatedAt: new Date().toISOString(),
      weights: this.weights,
      candidates: [...scored, ...eliminated],
    };
  }

  /**
   * The ordered fallback chain the dispatch orchestrator should try, in
   * order. An over-budget pinned candidate is excluded unless
   * `options.forceOverBudget` is set — a pin selects the provider, it does
   * not silently disable the budget ceiling.
   */
  route(spec: TaskSpec, options: RouteOptions = {}): Provider[] {
    const explanation = this.explain(spec);
    const usable = explanation.candidates
      .filter((c) => !c.eliminated && (!c.overBudget || options.forceOverBudget))
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

    const chain: Provider[] = [];
    for (const candidate of usable) {
      const provider = this.findProvider(candidate.providerId, candidate.modelId);
      if (provider) {
        chain.push(provider);
      }
    }
    return chain;
  }

  private findProvider(providerId: string, modelId: string): Provider | undefined {
    return this.providers.find((p) => {
      const cap = p.capabilities();
      return cap.providerId === providerId && cap.modelId === modelId;
    });
  }

  private resolveBudget(spec: TaskSpec): ResolvedBudget {
    return {
      maxUsd: spec.budget?.maxUsd ?? this.fallbackBudget.maxUsd,
      maxLatencyMs: spec.budget?.maxLatencyMs ?? this.fallbackBudget.maxLatencyMs,
    };
  }
}

interface HardFilterResult {
  eliminated: boolean;
  reason?: string;
  overBudget: boolean;
}

function hardFilter(
  spec: TaskSpec,
  profile: CapabilityProfile,
  requiredTokens: number,
  estimate: CostEstimate,
  budget: ResolvedBudget,
  isPinned: boolean,
): HardFilterResult {
  if (requiredTokens > profile.contextWindowTokens) {
    return {
      eliminated: true,
      reason: `estimated ~${requiredTokens} tokens exceeds context window of ${profile.contextWindowTokens}`,
      overBudget: false,
    };
  }

  if (needsToolSupport(spec) && !profile.supportsTools) {
    return {
      eliminated: true,
      reason: `spec expects "${spec.expects}" output, which requires tool support this provider does not have`,
      overBudget: false,
    };
  }

  if (spec.expects === "message" && !profile.supportsStructuredOutput) {
    return {
      eliminated: true,
      reason: 'spec expects structured "message" output, which this provider does not support',
      overBudget: false,
    };
  }

  const overCost = estimate.usd > budget.maxUsd;
  const overLatency = estimate.expectedLatencyMs > budget.maxLatencyMs;
  if (overCost || overLatency) {
    if (isPinned) {
      return { eliminated: false, overBudget: true };
    }
    const reason = overCost
      ? `estimated $${estimate.usd.toFixed(4)} exceeds budget ceiling of $${budget.maxUsd.toFixed(2)}`
      : `estimated ${estimate.expectedLatencyMs}ms exceeds latency ceiling of ${budget.maxLatencyMs}ms`;
    return { eliminated: true, reason, overBudget: false };
  }

  return { eliminated: false, overBudget: false };
}

function needsToolSupport(spec: TaskSpec): boolean {
  return spec.expects === "diff" || spec.expects === "artifact";
}

/** Laplace-smoothed point estimate: exactly 0.5 with zero data, for every candidate equally. */
function computeSuccessRate(
  attempts: number,
  successes: number,
  coldStartThreshold: number,
): SuccessRateBreakdown {
  return {
    attempts,
    successes,
    smoothed: (successes + 1) / (attempts + 2),
    confidence: Math.min(1, attempts / coldStartThreshold),
  };
}

/**
 * Scales the success-rate term's weight by how much data backs it, and
 * redistributes the unused weight across cost/latency/affinity in their
 * existing ratio, so the weights always sum to 1. A cold (provider,
 * taskType) pair ends up purely cost/latency/affinity-driven instead of
 * getting an unearned neutral 0.5 vote from success rate.
 */
function computeAdjustedScore(
  weights: RouterWeights,
  successRate: SuccessRateBreakdown,
  normCost: number,
  normLatency: number,
  affinity: number,
): number {
  const wSuccess = weights.successRate * successRate.confidence;
  const leftover = weights.successRate - wSuccess;
  const otherSum = weights.cost + weights.latency + weights.affinity;

  const wCost = weights.cost + (otherSum > 0 ? leftover * (weights.cost / otherSum) : 0);
  const wLatency = weights.latency + (otherSum > 0 ? leftover * (weights.latency / otherSum) : 0);
  const wAffinity = weights.affinity + (otherSum > 0 ? leftover * (weights.affinity / otherSum) : 0);

  return wCost * normCost + wLatency * normLatency + wSuccess * successRate.smoothed + wAffinity * affinity;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function splitPin(pin: string | undefined): [string | undefined, string | undefined] {
  if (!pin) {
    return [undefined, undefined];
  }
  const idx = pin.indexOf(":");
  return idx === -1 ? [pin, undefined] : [pin.slice(0, idx), pin.slice(idx + 1)];
}

import type { CapabilityProfile, CostEstimate, DispatchContext, DispatchEvent, Provider, TaskSpec } from "../types.js";

export interface ScriptedProviderConfig {
  providerId: string;
  modelId?: string;
  events: DispatchEvent[];
  estimateUsd?: number;
  expectedLatencyMs?: number;
  contextWindowTokens?: number;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
}

/** A Provider whose dispatch() replays a fixed, hand-written event sequence — for testing the fallback orchestrator without any network or scoring randomness. */
export class ScriptedProvider implements Provider {
  readonly id: string;
  private readonly profile: CapabilityProfile;
  private readonly events: DispatchEvent[];
  private readonly estimateUsd: number;
  private readonly expectedLatencyMs: number;

  constructor(config: ScriptedProviderConfig) {
    this.id = config.providerId;
    this.events = config.events;
    this.estimateUsd = config.estimateUsd ?? 0.001;
    this.expectedLatencyMs = config.expectedLatencyMs ?? 10;
    this.profile = {
      providerId: config.providerId,
      modelId: config.modelId ?? "default",
      taskTypeAffinity: {},
      contextWindowTokens: config.contextWindowTokens ?? 100_000,
      maxOutputTokens: 4096,
      supportsTools: config.supportsTools ?? true,
      supportsStructuredOutput: config.supportsStructuredOutput ?? true,
      inputCostPerMTok: config.inputCostPerMTok ?? 1,
      outputCostPerMTok: config.outputCostPerMTok ?? 1,
      asOf: "2026-01-01",
    };
  }

  capabilities(): CapabilityProfile {
    return this.profile;
  }

  estimate(): CostEstimate {
    return { usd: this.estimateUsd, expectedLatencyMs: this.expectedLatencyMs, confidence: 1 };
  }

  async *dispatch(_spec: TaskSpec, _ctx: DispatchContext, _signal: AbortSignal): AsyncIterable<DispatchEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

export function makeDispatchSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "test-spec",
    taskType: "bugfix",
    contextGlobs: [],
    constraints: [],
    expects: "diff",
    body: "fix it",
    ...overrides,
  };
}

export function makeDispatchCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceRoot: process.cwd(),
    resolvedContextFiles: [],
    ...overrides,
  };
}

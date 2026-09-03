import type {
  CapabilityProfile,
  CostEstimate,
  DispatchContext,
  DispatchEvent,
  Provider,
  TaskSpec,
} from "../types.js";

export interface FakeProviderConfig {
  providerId: string;
  modelId?: string;
  taskTypeAffinity?: Record<string, number>;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  usd?: number;
  expectedLatencyMs?: number;
}

/** A Provider stand-in with fully controllable capabilities/estimate — router tests never touch the network. */
export class FakeProvider implements Provider {
  readonly id: string;
  private readonly profile: CapabilityProfile;
  private readonly usd: number;
  private readonly expectedLatencyMs: number;

  constructor(config: FakeProviderConfig) {
    this.id = config.providerId;
    this.usd = config.usd ?? 0.01;
    this.expectedLatencyMs = config.expectedLatencyMs ?? 1000;
    this.profile = {
      providerId: config.providerId,
      modelId: config.modelId ?? "default",
      taskTypeAffinity: config.taskTypeAffinity ?? {},
      contextWindowTokens: config.contextWindowTokens ?? 100_000,
      maxOutputTokens: config.maxOutputTokens ?? 4096,
      supportsTools: config.supportsTools ?? true,
      supportsStructuredOutput: config.supportsStructuredOutput ?? true,
      inputCostPerMTok: 1,
      outputCostPerMTok: 1,
      asOf: "2026-01-01",
    };
  }

  capabilities(): CapabilityProfile {
    return this.profile;
  }

  estimate(): CostEstimate {
    return { usd: this.usd, expectedLatencyMs: this.expectedLatencyMs, confidence: 1 };
  }

  // eslint-disable-next-line require-yield -- intentionally never called in router tests
  async *dispatch(_spec: TaskSpec, _ctx: DispatchContext, _signal: AbortSignal): AsyncIterable<DispatchEvent> {
    throw new Error("FakeProvider.dispatch should not be called by router tests");
  }
}

export function makeRouterSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
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

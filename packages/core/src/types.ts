// Shared contract for the whole THP core. Zero `vscode` imports anywhere in
// this package — enforced by lint/CI, not just convention. See
// docs/DESIGN.md for the reasoning behind every shape here.

// ---------------------------------------------------------------------------
// Task spec
// ---------------------------------------------------------------------------

export type ExpectedOutput = "diff" | "artifact" | "message";

export interface TaskSpecBudget {
  maxUsd?: number;
  maxLatencyMs?: number;
}

export interface TaskSpec {
  /** Stable id, used as the telemetry key. Defaults to a slug of the file name. */
  id: string;
  /** Open string — drives affinity scoring, never validated against a closed enum. */
  taskType: string;
  /** Glob patterns (relative to workspace root) for files to attach as context. */
  contextGlobs: string[];
  /** Shell command, must exit 0 to pass. Absent means "unverified", not "passed". */
  acceptance?: string;
  /** Free-text constraints injected verbatim into every provider's prompt. */
  constraints: string[];
  /** Per-spec budget ceiling; falls back to workspace/hardcoded defaults when absent. */
  budget?: TaskSpecBudget;
  /** "providerId" or "providerId:modelId" escape hatch. Does not bypass the budget ceiling. */
  pinnedProvider?: string;
  expects: ExpectedOutput;
  /** Everything below the frontmatter fence — the human-readable intent. */
  body: string;
  /** Absolute path this spec was parsed from, when parsed from disk. */
  sourcePath?: string;
}

// ---------------------------------------------------------------------------
// Spec parsing errors — must name the offending field and line, never a
// generic "invalid spec" throw.
// ---------------------------------------------------------------------------

export interface SpecParseIssue {
  /** Dot path into the frontmatter object, e.g. "budget.maxUsd", or "$root". */
  field: string;
  message: string;
  /** 1-based line number in the source file. */
  line: number;
  /** 1-based column number in the source file. */
  column: number;
}

export class SpecParseError extends Error {
  readonly issues: SpecParseIssue[];

  constructor(issues: SpecParseIssue[]) {
    super(SpecParseError.formatMessage(issues));
    this.name = "SpecParseError";
    this.issues = issues;
  }

  private static formatMessage(issues: SpecParseIssue[]): string {
    return issues
      .map((i) => `${i.field} (line ${i.line}:${i.column}): ${i.message}`)
      .join("\n");
  }
}

// ---------------------------------------------------------------------------
// Provider capability + cost model
// ---------------------------------------------------------------------------

export interface CapabilityProfile {
  providerId: string;
  modelId: string;
  /** taskType -> 0..1 hand-curated prior. Unknown task types read as 0.5 (neutral), not 0. */
  taskTypeAffinity: Record<string, number>;
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  /** ISO date these pricing/affinity numbers were last checked against reality. */
  asOf: string;
}

export interface CostEstimate {
  usd: number;
  expectedLatencyMs: number;
  /** 0..1 — how much to trust this estimate (adapters report this honestly, not just 1.0). */
  confidence: number;
}

export interface ResolvedContextFile {
  path: string;
  content: string;
}

export interface DispatchContext {
  workspaceRoot: string;
  resolvedContextFiles: ResolvedContextFile[];
  apiKey?: string;
  /** Base URL override, used by the OpenAI-compatible adapter for local/self-hosted endpoints. */
  baseUrl?: string;
}

export type DispatchEvent =
  | { type: "token"; text: string }
  | { type: "toolCall"; id: string; name: string; input: unknown }
  | { type: "artifact"; name: string; mimeType: string; content: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" }
  | { type: "error"; message: string; retryable: boolean };

export interface Provider {
  readonly id: string;
  capabilities(): CapabilityProfile;
  estimate(spec: TaskSpec): CostEstimate;
  dispatch(
    spec: TaskSpec,
    ctx: DispatchContext,
    signal: AbortSignal,
  ): AsyncIterable<DispatchEvent>;
}

// ---------------------------------------------------------------------------
// Result envelope + verification
// ---------------------------------------------------------------------------

export type AcceptanceStatus = "passed" | "failed" | "skipped";

export interface AcceptanceResult {
  status: AcceptanceStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  command?: string;
  /** Set when status is "skipped" or when the command could not be run at all. */
  reason?: string;
}

export interface DispatchArtifact {
  name: string;
  mimeType: string;
  content: string;
}

export interface DispatchUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DispatchAttempt {
  providerId: string;
  modelId: string;
  startedAt: string;
  endedAt: string;
  usdSpent: number;
  latencyMs: number;
  diff?: string;
  artifacts: DispatchArtifact[];
  usage: DispatchUsage;
  acceptance: AcceptanceResult;
  error?: string;
}

export interface ResultEnvelope {
  specId: string;
  attempts: DispatchAttempt[];
  finalStatus: AcceptanceStatus;
  /** Index into attempts[] that ended the chain (passed, or the last one tried), if any. */
  chosenAttemptIndex?: number;
  totalUsdSpent: number;
  totalLatencyMs: number;
  /** Set when the chain stopped early, e.g. "budget exhausted", "no providers left". */
  stopReason?: string;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface RouterWeights {
  cost: number;
  latency: number;
  successRate: number;
  affinity: number;
}

export interface SuccessRateBreakdown {
  attempts: number;
  successes: number;
  /** Laplace-smoothed (successes+1)/(attempts+2). 0.5 with no data. */
  smoothed: number;
  /** min(1, attempts / coldStartThreshold) — how much weight this term actually carries. */
  confidence: number;
}

export interface CandidateExplanation {
  providerId: string;
  modelId: string;
  eliminated: boolean;
  eliminationReason?: string;
  /** True when this candidate only survived because it was pinned past the budget ceiling. */
  overBudget?: boolean;
  /** Always computed, even for eliminated candidates — the explain view is only useful if it shows why. */
  estimate: CostEstimate;
  affinity: number;
  successRate: SuccessRateBreakdown;
  /** Absent for eliminated candidates — they were never scored. */
  score?: number;
  rank?: number;
}

export interface RoutingExplanation {
  specId: string;
  generatedAt: string;
  weights: RouterWeights;
  candidates: CandidateExplanation[];
}

export interface RouteOptions {
  /** Allow a pinned provider to proceed even though it exceeds the budget ceiling. */
  forceOverBudget?: boolean;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetryRecord {
  specId: string;
  taskType: string;
  providerId: string;
  modelId: string;
  usd: number;
  latencyMs: number;
  acceptance: AcceptanceStatus;
  timestamp: string;
}

export interface TelemetryStats {
  attempts: number;
  successes: number;
}

export interface TelemetryStore {
  recordAttempt(record: TelemetryRecord): void;
  getStats(providerId: string, modelId: string, taskType: string): TelemetryStats;
  allRecords(): TelemetryRecord[];
  close(): void;
}

// ---------------------------------------------------------------------------
// Workspace config (.thp/config.json)
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  router?: {
    weights?: Partial<RouterWeights>;
    coldStartThreshold?: number;
  };
  budget?: TaskSpecBudget;
  providers?: Record<string, Partial<CapabilityProfile> & { baseUrl?: string }>;
}

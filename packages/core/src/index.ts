export * from "./types.js";

export { parseSpec, type ParseSpecOptions } from "./spec/parse.js";

export { AnthropicProvider, type AnthropicProviderOptions } from "./providers/anthropic.js";
export { GeminiProvider, type GeminiProviderOptions } from "./providers/gemini.js";
export {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderOptions,
} from "./providers/openai-compatible.js";
export { DEFAULT_CAPABILITY_MATRIX, findDefaultProfile } from "./providers/capability-matrix.js";
export { estimateFromProfile, estimateRequiredInputTokens } from "./providers/estimate.js";

export {
  DEFAULT_COLD_START_THRESHOLD,
  DEFAULT_WEIGHTS,
  HARD_FALLBACK_BUDGET,
  Router,
  type RouterOptions,
} from "./router/router.js";

export { runAcceptanceCommand, skippedAcceptance, type RunAcceptanceOptions } from "./envelope/acceptance.js";
export { ApplyDiffError, NotAGitRepoError, withScratchWorktree } from "./envelope/scratch.js";
export { dispatchWithFallback, type DispatchOptions } from "./envelope/dispatch.js";

export {
  InMemoryTelemetryStore,
  SqliteTelemetryStore,
  openTelemetryStore,
} from "./telemetry/store.js";

export {
  loadWorkspaceConfig,
  resolveRouterOptions,
  telemetryDbPath,
  WORKSPACE_CONFIG_RELATIVE_PATH,
} from "./config.js";

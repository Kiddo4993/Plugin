import type {
  CapabilityProfile,
  CostEstimate,
  DispatchContext,
  DispatchEvent,
  Provider,
  TaskSpec,
} from "../types.js";
import { findDefaultProfile } from "./capability-matrix.js";
import { estimateFromProfile } from "./estimate.js";
import { postJsonStream } from "./http.js";
import { buildPrompt } from "./prompt.js";
import { parseSse } from "./sse.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DONE_SENTINEL = "[DONE]";

export interface OpenAiCompatibleProviderOptions {
  /** Model id, e.g. "gpt-oss", or whatever a local server names its loaded model. */
  modelId?: string;
  /**
   * Base URL override — this one field is what makes this single adapter
   * cover Codex, GPT-OSS, and any local llama.cpp/Ollama endpoint that
   * speaks the OpenAI chat-completions shape.
   */
  baseUrl?: string;
  capabilityOverride?: Partial<CapabilityProfile>;
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for any OpenAI-compatible chat-completions endpoint. Unlike the
 * Anthropic and Gemini adapters, a missing API key is not an error here —
 * most local llama.cpp/Ollama servers require no auth at all.
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly id = "openai-compat";
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly profile: CapabilityProfile;

  constructor(options: OpenAiCompatibleProviderOptions = {}) {
    this.modelId = options.modelId ?? "gpt-oss";
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    const base =
      findDefaultProfile("openai-compat", this.modelId) ?? findDefaultProfile("openai-compat", "gpt-oss")!;
    this.profile = { ...base, modelId: this.modelId, ...options.capabilityOverride };
  }

  capabilities(): CapabilityProfile {
    return this.profile;
  }

  estimate(spec: TaskSpec): CostEstimate {
    return estimateFromProfile(this.profile, spec);
  }

  async *dispatch(
    spec: TaskSpec,
    ctx: DispatchContext,
    signal: AbortSignal,
  ): AsyncIterable<DispatchEvent> {
    const headers: Record<string, string> = {};
    if (ctx.apiKey) {
      headers.Authorization = `Bearer ${ctx.apiKey}`;
    }

    const result = await postJsonStream(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      headers,
      {
        model: this.modelId,
        stream: true,
        // Best-effort: real OpenAI honors this and emits a final
        // usage-only chunk; servers that don't recognize the field are
        // expected to ignore it. Usage falls back to 0 if never reported.
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: buildPrompt(spec, ctx) }],
      },
      signal,
      "openai-compat",
    );

    if (!result.ok || !result.body) {
      yield result.errorEvent!;
      return;
    }

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const frame of parseSse(result.body)) {
      if (frame.data === DONE_SENTINEL) {
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (!payload || typeof payload !== "object") {
        continue;
      }
      const chunk = payload as Record<string, unknown>;

      if (chunk.error) {
        const error = chunk.error as Record<string, unknown>;
        yield {
          type: "error",
          message: `openai-compat: ${String(error.message ?? "unknown error")}`,
          retryable: false,
        };
        return;
      }

      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        yield { type: "token", text: delta.content };
      }

      const usage = chunk.usage as Record<string, unknown> | undefined;
      if (typeof usage?.prompt_tokens === "number") {
        inputTokens = usage.prompt_tokens;
      }
      if (typeof usage?.completion_tokens === "number") {
        outputTokens = usage.completion_tokens;
      }
    }

    yield { type: "usage", inputTokens, outputTokens };
    yield { type: "done" };
  }
}

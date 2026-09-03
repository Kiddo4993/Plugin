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

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

export interface AnthropicProviderOptions {
  modelId?: string;
  baseUrl?: string;
  capabilityOverride?: Partial<CapabilityProfile>;
  /** Injected for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for the Anthropic Messages API (api.anthropic.com/v1/messages),
 * streamed via SSE. See docs/DESIGN.md §1.2 — this class holds only
 * request/response shaping; the shared fetch/SSE plumbing lives in
 * ./http.ts and ./sse.ts.
 */
export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly profile: CapabilityProfile;

  constructor(options: AnthropicProviderOptions = {}) {
    this.modelId = options.modelId ?? "claude-sonnet-5";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const base =
      findDefaultProfile("anthropic", this.modelId) ??
      findDefaultProfile("anthropic", "claude-sonnet-5")!;
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
    if (!ctx.apiKey) {
      yield { type: "error", message: "anthropic: no API key configured", retryable: false };
      return;
    }

    const result = await postJsonStream(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": ctx.apiKey, "anthropic-version": ANTHROPIC_API_VERSION },
      {
        model: this.modelId,
        max_tokens: this.profile.maxOutputTokens,
        stream: true,
        messages: [{ role: "user", content: buildPrompt(spec, ctx) }],
      },
      signal,
      "anthropic",
    );

    if (!result.ok || !result.body) {
      yield result.errorEvent!;
      return;
    }

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const frame of parseSse(result.body)) {
      let payload: unknown;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (!payload || typeof payload !== "object") {
        continue;
      }
      const event = payload as Record<string, unknown>;

      switch (event.type) {
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "token", text: delta.text };
          } else if (delta?.type === "input_json_delta") {
            // Tool-call argument streaming is surfaced only as the final
            // content_block_stop's accumulated JSON in this adapter's v1 —
            // partial JSON deltas are intentionally not forwarded as
            // separate events to keep the DispatchEvent union simple.
          }
          break;
        }
        case "message_start": {
          const message = event.message as Record<string, unknown> | undefined;
          const usage = message?.usage as Record<string, unknown> | undefined;
          if (typeof usage?.input_tokens === "number") {
            inputTokens = usage.input_tokens;
          }
          break;
        }
        case "message_delta": {
          const usage = event.usage as Record<string, unknown> | undefined;
          if (typeof usage?.output_tokens === "number") {
            outputTokens = usage.output_tokens;
          }
          break;
        }
        case "error": {
          const error = event.error as Record<string, unknown> | undefined;
          yield {
            type: "error",
            message: `anthropic: ${String(error?.message ?? "unknown error")}`,
            retryable: false,
          };
          return;
        }
        default:
          break;
      }
    }

    yield { type: "usage", inputTokens, outputTokens };
    yield { type: "done" };
  }
}

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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export interface GeminiProviderOptions {
  modelId?: string;
  baseUrl?: string;
  capabilityOverride?: Partial<CapabilityProfile>;
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for the Google Gemini API's streamGenerateContent endpoint
 * (generativelanguage.googleapis.com), streamed via SSE (`alt=sse`).
 */
export class GeminiProvider implements Provider {
  readonly id = "google";
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly profile: CapabilityProfile;

  constructor(options: GeminiProviderOptions = {}) {
    this.modelId = options.modelId ?? "gemini-3";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const base = findDefaultProfile("google", this.modelId) ?? findDefaultProfile("google", "gemini-3")!;
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
      yield { type: "error", message: "google: no API key configured", retryable: false };
      return;
    }

    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelId)}:streamGenerateContent?alt=sse`;

    const result = await postJsonStream(
      this.fetchImpl,
      url,
      { "x-goog-api-key": ctx.apiKey },
      {
        contents: [{ role: "user", parts: [{ text: buildPrompt(spec, ctx) }] }],
      },
      signal,
      "google",
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
      const chunk = payload as Record<string, unknown>;

      if (chunk.error) {
        const error = chunk.error as Record<string, unknown>;
        yield {
          type: "error",
          message: `google: ${String(error.message ?? "unknown error")}`,
          retryable: false,
        };
        return;
      }

      const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
      const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as
        | Array<Record<string, unknown>>
        | undefined;
      if (parts) {
        for (const part of parts) {
          if (typeof part.text === "string") {
            yield { type: "token", text: part.text };
          }
        }
      }

      const usage = chunk.usageMetadata as Record<string, unknown> | undefined;
      if (typeof usage?.promptTokenCount === "number") {
        inputTokens = usage.promptTokenCount;
      }
      if (typeof usage?.candidatesTokenCount === "number") {
        outputTokens = usage.candidatesTokenCount;
      }
    }

    yield { type: "usage", inputTokens, outputTokens };
    yield { type: "done" };
  }
}

import { describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "./gemini.js";
import { stringToStream } from "./sse.js";
import {
  collectEvents,
  fixtureFetch,
  makeCtx,
  makeCtxWithoutApiKey,
  makeSpec,
  readFixture,
  tokensOf,
  usageOf,
} from "./test-helpers.js";

describe("GeminiProvider", () => {
  it("streams tokens and reports usage from a recorded fixture", async () => {
    const sse = readFixture("gemini/basic.sse.txt");
    const provider = new GeminiProvider({ fetchImpl: fixtureFetch(sse) });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtx(), new AbortController().signal),
    );

    expect(tokensOf(events)).toBe("Hello, world");
    expect(usageOf(events)).toEqual({ type: "usage", inputTokens: 10, outputTokens: 3 });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("sends the request Gemini's streamGenerateContent endpoint expects", async () => {
    const sse = readFixture("gemini/basic.sse.txt");
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(stringToStream(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider({ fetchImpl, modelId: "gemini-3" });
    await collectEvents(
      provider.dispatch(makeSpec(), makeCtx({ apiKey: "goog-test-key" }), new AbortController().signal),
    );

    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3:streamGenerateContent?alt=sse",
    );
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("goog-test-key");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    const contents = body.contents as Array<{ parts: Array<{ text: string }> }>;
    expect(contents[0]?.parts[0]?.text).toContain("Fix the thing.");
  });

  it("yields an error event and never calls fetch when no API key is configured", async () => {
    const fetchImpl = vi.fn();
    const provider = new GeminiProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtxWithoutApiKey(), new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "error", message: "google: no API key configured", retryable: false },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("yields a non-retryable error on an in-band error payload", async () => {
    const sse = 'data: {"error":{"message":"quota exceeded"}}\n\n';
    const provider = new GeminiProvider({ fetchImpl: fixtureFetch(sse) });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtx(), new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "error", message: "google: quota exceeded", retryable: false },
    ]);
  });

  it("reports a 1M-token context window by default", () => {
    const provider = new GeminiProvider();
    expect(provider.capabilities().contextWindowTokens).toBe(1_000_000);
  });
});

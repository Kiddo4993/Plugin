import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
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

describe("AnthropicProvider", () => {
  it("streams tokens and reports usage from a recorded fixture", async () => {
    const sse = readFixture("anthropic/basic.sse.txt");
    const provider = new AnthropicProvider({ fetchImpl: fixtureFetch(sse) });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtx(), new AbortController().signal),
    );

    expect(tokensOf(events)).toBe("Hello, world");
    expect(usageOf(events)).toEqual({ type: "usage", inputTokens: 42, outputTokens: 5 });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("sends the request Anthropic's Messages API expects", async () => {
    const sse = readFixture("anthropic/basic.sse.txt");
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(stringToStream(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider({ fetchImpl, modelId: "claude-sonnet-5" });
    await collectEvents(
      provider.dispatch(
        makeSpec({ constraints: ["no new deps"] }),
        makeCtx({ apiKey: "sk-ant-test" }),
        new AbortController().signal,
      ),
    );

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.stream).toBe(true);
    const messages = body.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toContain("no new deps");
    expect(messages[0]?.content).toContain("Fix the thing.");
  });

  it("yields an error event and never calls fetch when no API key is configured", async () => {
    const fetchImpl = vi.fn();
    const provider = new AnthropicProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtxWithoutApiKey(), new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "error", message: "anthropic: no API key configured", retryable: false },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("yields a retryable error on a 5xx response", async () => {
    const provider = new AnthropicProvider({ fetchImpl: fixtureFetch("", 500) });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtx(), new AbortController().signal),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retryable: true });
  });

  it("yields a non-retryable error and stops on a streamed error event", async () => {
    const sse = 'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n';
    const provider = new AnthropicProvider({ fetchImpl: fixtureFetch(sse) });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtx(), new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "error", message: "anthropic: overloaded", retryable: false },
    ]);
  });

  it("reports its capability profile and a plausible estimate", () => {
    const provider = new AnthropicProvider();
    const caps = provider.capabilities();
    expect(caps.providerId).toBe("anthropic");
    expect(caps.contextWindowTokens).toBeGreaterThan(0);

    const estimate = provider.estimate(makeSpec());
    expect(estimate.usd).toBeGreaterThanOrEqual(0);
    expect(estimate.expectedLatencyMs).toBeGreaterThan(0);
  });
});

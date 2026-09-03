import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { stringToStream } from "./sse.js";
import { collectEvents, fixtureFetch, makeCtxWithoutApiKey, makeSpec, readFixture, tokensOf, usageOf } from "./test-helpers.js";

describe("OpenAiCompatibleProvider", () => {
  it("streams tokens and reports usage from a recorded fixture", async () => {
    const sse = readFixture("openai-compat/basic.sse.txt");
    const provider = new OpenAiCompatibleProvider({ fetchImpl: fixtureFetch(sse) });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtxWithoutApiKey(), new AbortController().signal),
    );

    expect(tokensOf(events)).toBe("Hello, world");
    expect(usageOf(events)).toEqual({ type: "usage", inputTokens: 8, outputTokens: 4 });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("does NOT error when no API key is configured — local servers commonly need none", async () => {
    const sse = readFixture("openai-compat/basic.sse.txt");
    const provider = new OpenAiCompatibleProvider({ fetchImpl: fixtureFetch(sse) });

    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtxWithoutApiKey(), new AbortController().signal),
    );

    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("omits the Authorization header when no key is given, and sets it when one is", async () => {
    const sse = readFixture("openai-compat/basic.sse.txt");
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(stringToStream(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider({ fetchImpl });
    await collectEvents(
      provider.dispatch(makeSpec(), makeCtxWithoutApiKey(), new AbortController().signal),
    );
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBeUndefined();

    await collectEvents(
      provider.dispatch(
        makeSpec(),
        { workspaceRoot: "/workspace", resolvedContextFiles: [], apiKey: "sk-test" },
        new AbortController().signal,
      ),
    );
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("routes to a local baseUrl override, covering llama.cpp/Ollama/Codex", async () => {
    const sse = readFixture("openai-compat/basic.sse.txt");
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(stringToStream(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider({
      fetchImpl,
      baseUrl: "http://localhost:11434/v1",
      modelId: "local",
    });
    await collectEvents(
      provider.dispatch(makeSpec(), makeCtxWithoutApiKey(), new AbortController().signal),
    );

    expect(capturedUrl).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("stops at the [DONE] sentinel without treating it as JSON", async () => {
    const sse = readFixture("openai-compat/basic.sse.txt");
    const provider = new OpenAiCompatibleProvider({ fetchImpl: fixtureFetch(sse) });
    const events = await collectEvents(
      provider.dispatch(makeSpec(), makeCtxWithoutApiKey(), new AbortController().signal),
    );
    // The fixture's [DONE] line must not produce an error or a spurious token.
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });
});

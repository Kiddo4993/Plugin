import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DispatchContext, DispatchEvent, TaskSpec } from "../types.js";
import { stringToStream } from "./sse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "../../test/fixtures");

/** Reads a recorded SSE fixture from packages/core/test/fixtures/<relPath>. */
export function readFixture(relPath: string): string {
  return readFileSync(path.join(fixturesRoot, relPath), "utf8");
}

/** A fetch stand-in that ignores the request and returns a canned SSE response body. */
export function fixtureFetch(sseText: string, status = 200): typeof fetch {
  return (async () =>
    new Response(stringToStream(sseText), {
      status,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

export function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "test-spec",
    taskType: "bugfix",
    contextGlobs: [],
    constraints: [],
    expects: "diff",
    body: "Fix the thing.",
    ...overrides,
  };
}

export function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceRoot: "/workspace",
    resolvedContextFiles: [],
    apiKey: "test-key",
    ...overrides,
  };
}

/**
 * A DispatchContext with no `apiKey` property at all (not one set to
 * `undefined` — exactOptionalPropertyTypes forbids that assignment, and
 * omitting the key entirely is exactly what "no key configured" means).
 */
export function makeCtxWithoutApiKey(
  overrides: Partial<Omit<DispatchContext, "apiKey">> = {},
): DispatchContext {
  return {
    workspaceRoot: "/workspace",
    resolvedContextFiles: [],
    ...overrides,
  };
}

export async function collectEvents(iterable: AsyncIterable<DispatchEvent>): Promise<DispatchEvent[]> {
  const events: DispatchEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

export function tokensOf(events: DispatchEvent[]): string {
  return events
    .filter((e): e is Extract<DispatchEvent, { type: "token" }> => e.type === "token")
    .map((e) => e.text)
    .join("");
}

export function usageOf(events: DispatchEvent[]): Extract<DispatchEvent, { type: "usage" }> | undefined {
  return events.find((e): e is Extract<DispatchEvent, { type: "usage" }> => e.type === "usage");
}

import { describe, expect, it } from "vitest";
import { parseSse, stringToStream } from "./sse.js";

async function collect(stream: ReadableStream<Uint8Array>) {
  const frames = [];
  for await (const frame of parseSse(stream)) {
    frames.push(frame);
  }
  return frames;
}

describe("parseSse", () => {
  it("parses simple data-only events", async () => {
    const text = 'data: {"a":1}\n\ndata: {"a":2}\n\n';
    const frames = await collect(stringToStream(text));
    expect(frames).toEqual([{ data: '{"a":1}' }, { data: '{"a":2}' }]);
  });

  it("joins multi-line data fields with newlines", async () => {
    const text = "data: line one\ndata: line two\n\n";
    const frames = await collect(stringToStream(text));
    expect(frames).toEqual([{ data: "line one\nline two" }]);
  });

  it("captures the event name alongside data", async () => {
    const text = "event: message_start\ndata: {}\n\n";
    const frames = await collect(stringToStream(text));
    expect(frames).toEqual([{ event: "message_start", data: "{}" }]);
  });

  it("ignores comment lines", async () => {
    const text = ": keep-alive\n\ndata: real\n\n";
    const frames = await collect(stringToStream(text));
    expect(frames).toEqual([{ data: "real" }]);
  });

  it("handles a trailing block with no terminating blank line", async () => {
    const text = "data: first\n\ndata: last-no-trailing-blank";
    const frames = await collect(stringToStream(text));
    expect(frames).toEqual([{ data: "first" }, { data: "last-no-trailing-blank" }]);
  });

  it("handles CRLF line endings", async () => {
    const text = "data: crlf\r\n\r\n";
    const frames = await collect(stringToStream(text));
    expect(frames).toEqual([{ data: "crlf" }]);
  });

  it("returns nothing for an empty stream", async () => {
    const frames = await collect(stringToStream(""));
    expect(frames).toEqual([]);
  });
});

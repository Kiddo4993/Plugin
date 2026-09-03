export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * Parses a fetch Response body as Server-Sent Events, yielding one frame per
 * event block (blocks are separated by a blank line; multi-line `data:`
 * fields are joined with '\n', per the SSE spec). Operates on any
 * ReadableStream<Uint8Array>, so tests can feed it a canned stream built
 * from a recorded fixture instead of a live HTTP response.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseEventBlock(block);
        if (frame) {
          yield frame;
        }
      }
    }

    const rest = buffer.trim();
    if (rest.length > 0) {
      const frame = parseEventBlock(rest);
      if (frame) {
        yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SseFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue; // blank line within a block (shouldn't happen) or a comment
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (dataLines.length === 0) {
    return null;
  }
  return event !== undefined ? { event, data: dataLines.join("\n") } : { data: dataLines.join("\n") };
}

/** Builds a ReadableStream<Uint8Array> from a plain string — used by adapter tests to replay fixtures. */
export function stringToStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

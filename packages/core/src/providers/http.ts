import type { DispatchEvent } from "../types.js";

export interface StreamRequestResult {
  ok: boolean;
  body?: ReadableStream<Uint8Array>;
  errorEvent?: Extract<DispatchEvent, { type: "error" }>;
}

/**
 * POSTs JSON and returns either the response's readable body or a
 * normalized "error" DispatchEvent — shared by all three adapters, which
 * otherwise duplicate this exact fetch/error-shape three times over.
 */
export async function postJsonStream(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  signal: AbortSignal,
  providerLabel: string,
): Promise<StreamRequestResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      errorEvent: {
        type: "error",
        message: `${providerLabel}: request failed: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }

  if (!response.ok || !response.body) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // best-effort detail only
    }
    return {
      ok: false,
      errorEvent: {
        type: "error",
        message: `${providerLabel}: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
        retryable: response.status >= 500 || response.status === 429,
      },
    };
  }

  return { ok: true, body: response.body };
}

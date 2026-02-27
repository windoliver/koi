/**
 * Generic fetch wrapper with timeout and auth header injection.
 */

import type { KoiError, Result } from "@koi/core";
import { DEFAULT_TIMEOUT_MS } from "./config.js";
import { mapHttpError, mapNetworkError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpClientConfig {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly timeoutMs?: number;
  readonly fetch: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Make an authenticated HTTP request with timeout.
 * Returns the parsed JSON body on success, or a KoiError on failure.
 */
export async function httpRequest<T>(
  client: HttpClientConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Result<T, KoiError>> {
  const url = `${client.baseUrl}${path}`;
  const timeout = client.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await client.fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${client.authToken}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: mapHttpError(response.status, text, url) };
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return { ok: true, value: undefined as T };
    }

    const data = (await response.json()) as T;
    return { ok: true, value: data };
  } catch (e: unknown) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `Request to ${url} timed out after ${timeout}ms`,
          retryable: true,
          context: { url, timeoutMs: timeout },
        },
      };
    }
    return { ok: false, error: mapNetworkError(e, url) };
  }
}

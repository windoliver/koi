/**
 * createNexusRestClient — shared REST transport for Nexus HTTP APIs.
 *
 * Extracts the common HTTP plumbing (fetch + timeout + error mapping + auth)
 * used by L2 packages like @koi/ipc-nexus and @koi/scratchpad-nexus.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusRestClientConfig {
  /** Nexus server base URL (e.g., "http://localhost:2026"). */
  readonly baseUrl: string;
  /** Request timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  /** Bearer token for authentication. */
  readonly authToken?: string | undefined;
  /** Injectable fetch for testing/tracing. Default: globalThis.fetch. */
  readonly fetch?:
    | typeof globalThis.fetch
    | ((input: Request | string | URL, init?: RequestInit) => Promise<Response>)
    | undefined;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface NexusRestClient {
  readonly request: <T>(
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Result<T, KoiError>>;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

/** Map an HTTP error status to a KoiError with contextual message. */
export function mapRestHttpError(status: number, body: string, context: string): KoiError {
  if (status === 404) {
    return {
      code: "NOT_FOUND",
      message: `${context}: resource not found`,
      retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
      context: { status },
    };
  }
  if (status === 403 || status === 401) {
    return {
      code: "PERMISSION",
      message: `${context}: unauthorized (HTTP ${String(status)})`,
      retryable: RETRYABLE_DEFAULTS.PERMISSION,
      context: { status },
    };
  }
  if (status === 409) {
    return {
      code: "CONFLICT",
      message: `${context}: conflict`,
      retryable: RETRYABLE_DEFAULTS.CONFLICT,
      context: { status },
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: `${context}: rate limited`,
      retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
      context: { status },
    };
  }
  if (status === 408 || status === 504) {
    return {
      code: "TIMEOUT",
      message: `${context}: request timed out (HTTP ${String(status)})`,
      retryable: RETRYABLE_DEFAULTS.TIMEOUT,
      context: { status },
    };
  }
  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `${context}: server error (HTTP ${String(status)})`,
      retryable: true,
      context: { status, body },
    };
  }
  return {
    code: "EXTERNAL",
    message: `${context}: unexpected response (HTTP ${String(status)})`,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
    context: { status, body },
  };
}

/** Map a fetch-level error (network, timeout) to a KoiError. */
export function mapRestFetchError(err: unknown, context: string): KoiError {
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout = message.includes("abort") || message.includes("timeout");
  return {
    code: isTimeout ? "TIMEOUT" : "EXTERNAL",
    message: `${context}: ${message}`,
    retryable: isTimeout ? RETRYABLE_DEFAULTS.TIMEOUT : RETRYABLE_DEFAULTS.EXTERNAL,
    cause: err,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus REST client with shared fetch, timeout, and error mapping. */
export function createNexusRestClient(config: NexusRestClientConfig): NexusRestClient {
  const { baseUrl, authToken } = config;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = config.fetch ?? globalThis.fetch;

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken !== undefined) {
      h.Authorization = `Bearer ${authToken}`;
    }
    return h;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Result<T, KoiError>> {
    const url = `${baseUrl}${path}`;
    const context = `Nexus ${method} ${path}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetchFn(url, {
        method,
        headers: headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text();
        return { ok: false, error: mapRestHttpError(resp.status, text, context) };
      }

      // 204 No Content — return void-typed result
      if (resp.status === 204) {
        return { ok: true, value: undefined as T };
      }

      const json = (await resp.json()) as T;
      return { ok: true, value: json };
    } catch (e: unknown) {
      return { ok: false, error: mapRestFetchError(e, context) };
    }
  }

  return { request };
}

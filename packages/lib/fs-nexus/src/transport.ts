/**
 * Inline JSON-RPC 2.0 transport for Nexus server.
 *
 * Will be extracted to @koi/nexus-client when a second consumer exists.
 */

import type { KoiError, Result } from "@koi/core";
import { mapNexusError } from "./errors.js";
import type { JsonRpcResponse, NexusFileSystemConfig, NexusTransport } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DEADLINE_MS = 45_000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an HTTP JSON-RPC transport to a Nexus server. */
export function createHttpTransport(config: NexusFileSystemConfig): NexusTransport {
  const { url, apiKey } = config;
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRetries = config.retries ?? DEFAULT_RETRIES;
  const abortController = new AbortController();
  let nextId = 1;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    const deadline = Date.now() + deadlineMs;
    let lastError: KoiError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          ok: false,
          error: lastError ?? mapNexusError(new Error("deadline exceeded"), method),
        };
      }

      // Backoff between retries (skip for first attempt)
      if (attempt > 0) {
        const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        const jitter = Math.random() * backoff * 0.2;
        const delay = Math.min(backoff + jitter, remaining);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      try {
        const requestId = nextId++;
        const perRequestTimeout = Math.min(remaining, deadlineMs);
        const timeoutSignal = AbortSignal.timeout(perRequestTimeout);
        const signal = AbortSignal.any([abortController.signal, timeoutSignal]);

        const response = await fetch(`${url}/api/nfs/${encodeURIComponent(method)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method,
            params,
            id: requestId,
          }),
          signal,
        });

        // HTTP-level errors
        if (!response.ok) {
          const error = mapNexusError(
            { status: response.status, statusText: response.statusText },
            method,
          );
          if (!error.retryable || attempt >= maxRetries) {
            return { ok: false, error };
          }
          lastError = error;
          continue;
        }

        // Parse JSON-RPC response
        const body = (await response.json()) as JsonRpcResponse<T>;

        if (body.error !== undefined) {
          const error = mapNexusError(body.error, method);
          if (!error.retryable || attempt >= maxRetries) {
            return { ok: false, error };
          }
          lastError = error;
          continue;
        }

        return { ok: true, value: body.result as T };
      } catch (e: unknown) {
        const error = mapNexusError(e, method);
        if (!error.retryable || attempt >= maxRetries) {
          return { ok: false, error };
        }
        lastError = error;
      }
    }

    // Should be unreachable, but TypeScript needs it
    return {
      ok: false,
      error: lastError ?? mapNexusError(new Error("exhausted retries"), method),
    };
  }

  function close(): void {
    abortController.abort();
  }

  return { call, close };
}

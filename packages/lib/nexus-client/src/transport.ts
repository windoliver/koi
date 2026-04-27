import type { KoiError, Result } from "@koi/core";
import { mapNexusError } from "./errors.js";
import type { FetchFn, JsonRpcResponse, NexusTransport, NexusTransportConfig } from "./types.js";

const DEFAULT_DEADLINE_MS = 45_000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

/** Read-only / idempotent methods safe to retry on transient failure. */
const RETRYABLE_METHODS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "grep",
  "search",
  "stat",
  "exists",
  "glob",
  "is_directory",
  "permissions.check",
  "permissions.checkBatch",
  "revocations.check",
  "revocations.checkBatch",
  "version",
]);

export function createHttpTransport(config: NexusTransportConfig): NexusTransport {
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRetries = config.retries ?? DEFAULT_RETRIES;
  const fetchFn: FetchFn = config.fetch ?? globalThis.fetch;
  const abortController = new AbortController();
  // let justified: monotonic counter for JSON-RPC request IDs
  let nextId = 1;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    const deadline = Date.now() + deadlineMs;
    const effectiveRetries = RETRYABLE_METHODS.has(method) ? maxRetries : 0;
    let lastError: KoiError | undefined;

    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          ok: false,
          error: lastError ?? mapNexusError(new Error("deadline exceeded"), method),
        };
      }

      if (attempt > 0) {
        const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        const jitter = Math.random() * backoff * 0.2;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(backoff + jitter, remaining)),
        );
      }

      try {
        const id = nextId++;
        const timeoutSignal = AbortSignal.timeout(Math.min(remaining, deadlineMs));
        const signal = AbortSignal.any([abortController.signal, timeoutSignal]);

        const response = await fetchFn(`${config.url}/api/nfs/${encodeURIComponent(method)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey !== undefined ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
          signal,
        });

        if (!response.ok) {
          const error = mapNexusError(
            { status: response.status, statusText: response.statusText },
            method,
          );
          if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
          lastError = error;
          continue;
        }

        const body = (await response.json()) as JsonRpcResponse<T>;
        if (body.error !== undefined) {
          const error = mapNexusError(body.error, method);
          if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
          lastError = error;
          continue;
        }

        return { ok: true, value: body.result as T };
      } catch (e: unknown) {
        const error = mapNexusError(e, method);
        if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
        lastError = error;
      }
    }

    return { ok: false, error: lastError ?? mapNexusError(new Error("exhausted retries"), method) };
  }

  function close(): void {
    abortController.abort();
  }

  return { call, close };
}

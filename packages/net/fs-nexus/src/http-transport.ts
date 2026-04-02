/**
 * HTTP JSON-RPC transport for Nexus.
 *
 * Sends JSON-RPC 2.0 requests over HTTP POST. Each call gets a unique
 * incrementing ID. Timeout is enforced via AbortSignal.
 */

import type { HttpTransportConfig, NexusTransport } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Map HTTP/network errors to descriptive messages. */
function describeError(error: unknown, method: string): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `Nexus RPC '${method}' timed out`;
  }
  if (error instanceof TypeError && String(error.message).includes("fetch")) {
    return `Nexus connection failed for '${method}': ${error.message}`;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return `Nexus RPC '${method}' failed: ${msg}`;
}

export function createHttpTransport(config: HttpTransportConfig): NexusTransport {
  const { url, timeout = DEFAULT_TIMEOUT_MS } = config;
  const fetchFn = config.fetch ?? globalThis.fetch;

  let nextId = 1;
  let closed = false;

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (closed) {
      throw new Error(`Transport closed — cannot call '${method}'`);
    }

    const id = nextId;
    nextId += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetchFn(`${url}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}: ${response.statusText}`);
      }

      const body = (await response.json()) as Record<string, unknown>;

      // Validate JSON-RPC 2.0 envelope
      if (body.jsonrpc !== "2.0") {
        throw new Error(
          `Invalid JSON-RPC response: missing or wrong 'jsonrpc' field (got ${String(body.jsonrpc)})`,
        );
      }
      if (body.id !== id) {
        throw new Error(
          `JSON-RPC response id mismatch: expected ${String(id)}, got ${String(body.id)}`,
        );
      }
      const hasResult = "result" in body;
      const hasError = "error" in body;
      if (hasResult === hasError) {
        throw new Error(
          "Invalid JSON-RPC response: must contain exactly one of 'result' or 'error'",
        );
      }

      if (hasError) {
        const err = body.error as { readonly code: number; readonly message: string };
        throw new Error(`RPC error ${String(err.code)}: ${err.message}`);
      }

      return body.result as T;
    } catch (error: unknown) {
      throw new Error(describeError(error, method), { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async function close(): Promise<void> {
    closed = true;
  }

  return { call, close };
}

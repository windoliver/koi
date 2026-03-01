/**
 * Outbound request tracker for the ACP server.
 *
 * Manages the lifecycle of JSON-RPC requests sent from Koi to the IDE
 * (e.g., session/request_permission). Each request gets a unique ID,
 * a per-type timeout, and a promise that resolves when the IDE responds.
 */

import type { AcpTransport, RpcId } from "@koi/acp-protocol";
import { buildRequest } from "@koi/acp-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingOutbound {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RequestTracker {
  /** Send a JSON-RPC request and wait for the response with per-type timeout. */
  readonly sendRequest: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** Resolve a pending request by its RPC ID (called by the receive loop). */
  readonly resolveResponse: (id: RpcId, result: unknown) => void;
  /** Reject a pending request with an error (called by the receive loop). */
  readonly rejectResponse: (
    id: RpcId,
    error: { readonly code: number; readonly message: string },
  ) => void;
  /** Reject all pending requests (used during shutdown). */
  readonly rejectAll: (reason: string) => void;
  /** Number of currently pending requests. */
  readonly pending: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRequestTracker(transport: AcpTransport): RequestTracker {
  const pending = new Map<string | number, PendingOutbound>();

  function sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const { id, message } = buildRequest(method, params);

      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (entry !== undefined) {
          pending.delete(id);
          entry.reject(new Error(`[acp] Request "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      transport.send(message);
    });
  }

  function resolveResponse(id: RpcId, result: unknown): void {
    if (id === null) return;
    const key = typeof id === "string" ? id : id;
    const entry = pending.get(key);
    if (entry !== undefined) {
      pending.delete(key);
      clearTimeout(entry.timer);
      entry.resolve(result);
    }
  }

  function rejectResponse(
    id: RpcId,
    error: { readonly code: number; readonly message: string },
  ): void {
    if (id === null) return;
    const key = typeof id === "string" ? id : id;
    const entry = pending.get(key);
    if (entry !== undefined) {
      pending.delete(key);
      clearTimeout(entry.timer);
      entry.reject(new Error(`[acp] RPC error (${error.code}): ${error.message}`));
    }
  }

  function rejectAll(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`[acp] ${reason}`));
      pending.delete(id);
    }
  }

  return {
    sendRequest,
    resolveResponse,
    rejectResponse,
    rejectAll,
    pending: () => pending.size,
  };
}

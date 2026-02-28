/**
 * JSON-RPC 2.0 line-buffer parser and message router for ACP.
 *
 * Adapts engine-external's line-parser pattern (decision 13A) for the
 * bidirectional JSON-RPC protocol ACP uses over stdin/stdout.
 *
 * Inbound message types (Agent → Koi):
 * - Notification: has `method`, no `id` → pushed to notification queue
 * - Request: has `method` and `id` → pushed to inbound request queue
 * - Response: has `id`, no `method` → resolves a pending outbound request
 */

import type { RpcId } from "./acp-schema.js";
import { parseAnyRpcMessage } from "./acp-schema.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 standard error codes
// ---------------------------------------------------------------------------

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

// ---------------------------------------------------------------------------
// Discriminated message kinds
// ---------------------------------------------------------------------------

/** A notification from the agent (no `id`, has `method`). */
export interface RpcNotification {
  readonly kind: "notification";
  readonly method: string;
  readonly params: unknown;
}

/** A request from the agent to Koi (has both `method` and `id`). */
export interface RpcInboundRequest {
  readonly kind: "inbound_request";
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
}

/** A successful response to one of Koi's outbound requests. */
export interface RpcSuccessResponse {
  readonly kind: "success_response";
  readonly id: RpcId;
  readonly result: unknown;
}

/** An error response to one of Koi's outbound requests. */
export interface RpcErrorResponse {
  readonly kind: "error_response";
  readonly id: RpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type RpcMessage =
  | RpcNotification
  | RpcInboundRequest
  | RpcSuccessResponse
  | RpcErrorResponse;

// ---------------------------------------------------------------------------
// Line buffer — stateful per receive stream
// ---------------------------------------------------------------------------

/**
 * Parses a stream of string chunks into complete JSON-RPC messages.
 * Buffers partial lines across chunk boundaries.
 */
export interface LineParser {
  /** Feed a chunk of text; returns zero or more parsed messages. */
  readonly feed: (chunk: string) => readonly RpcMessage[];
  /** Flush any remaining partial line (e.g., on stream close). */
  readonly flush: () => readonly RpcMessage[];
}

export function createLineParser(): LineParser {
  // let: partial line buffer across chunks
  let buffer = "";

  function parseLine(line: string): RpcMessage | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Parse error — no id available, so we emit a custom error marker
      // (transport layer will log; can't send error response without an id)
      console.warn(`[engine-acp] JSON parse error on line: ${trimmed.slice(0, 100)}`);
      return undefined;
    }

    const msg = parseAnyRpcMessage(parsed);
    if (msg === undefined) {
      console.warn("[engine-acp] Invalid JSON-RPC message shape: failed to parse");
      return undefined;
    }

    // Discriminate by presence of `method` and `id`
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        // Inbound request from agent (has id + method)
        return {
          kind: "inbound_request",
          id: msg.id,
          method: msg.method,
          params: msg.params,
        };
      }
      // Notification (no id)
      return {
        kind: "notification",
        method: msg.method,
        params: msg.params,
      };
    }

    // Response (no method)
    if (msg.id !== undefined) {
      if (msg.error !== undefined) {
        return {
          kind: "error_response",
          id: msg.id,
          error: msg.error,
        };
      }
      if ("result" in msg) {
        return {
          kind: "success_response",
          id: msg.id,
          result: msg.result,
        };
      }
    }

    console.warn("[engine-acp] Unroutable JSON-RPC message:", trimmed.slice(0, 100));
    return undefined;
  }

  return {
    feed(chunk: string): readonly RpcMessage[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      // Last element may be incomplete — keep it buffered
      buffer = lines.pop() ?? "";

      const messages: RpcMessage[] = [];
      for (const line of lines) {
        const msg = parseLine(line);
        if (msg !== undefined) {
          messages.push(msg);
        }
      }
      return messages;
    },

    flush(): readonly RpcMessage[] {
      if (buffer.length === 0) return [];
      const remaining = buffer;
      buffer = "";
      const msg = parseLine(remaining);
      return msg !== undefined ? [msg] : [];
    },
  };
}

// ---------------------------------------------------------------------------
// Outgoing request serialiser
// ---------------------------------------------------------------------------

/** Counter for generating monotonically increasing request IDs. */
let nextId = 0;

/** Build a JSON-RPC request object and return its ID. */
export function buildRequest(
  method: string,
  params: unknown,
): { readonly id: number; readonly message: string } {
  const id = nextId++;
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return { id, message };
}

/** Build a JSON-RPC success response string for an inbound request. */
export function buildResponse(id: RpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** Build a JSON-RPC error response string for an inbound request. */
export function buildErrorResponse(
  id: RpcId,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error = data !== undefined ? { code, message, data } : { code, message };
  return JSON.stringify({ jsonrpc: "2.0", id, error });
}

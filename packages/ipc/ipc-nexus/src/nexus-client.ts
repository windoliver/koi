/**
 * Thin HTTP client for the Nexus IPC REST API.
 *
 * Wire types are local to this module — they match the actual Nexus REST API
 * shapes (snake_case fields, "type" not "kind") and never leak into L0.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { DEFAULT_NEXUS_BASE_URL, DEFAULT_TIMEOUT_MS } from "./constants.js";

// ---------------------------------------------------------------------------
// Wire types — match actual Nexus REST API shapes
// ---------------------------------------------------------------------------

/**
 * Send request body — POST /api/v2/ipc/send.
 *
 * Matches Nexus SendMessageRequest (ipc.py):
 *   sender, recipient, type, payload, correlation_id, ttl_seconds, message_id
 */
export interface NexusSendRequest {
  readonly sender: string;
  readonly recipient: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly correlation_id?: string | undefined;
  readonly ttl_seconds?: number | undefined;
  readonly message_id?: string | undefined;
}

/**
 * Send response — returned by POST /api/v2/ipc/send.
 *
 * Matches the actual dict returned by send_message handler:
 *   message_id, path, sender, recipient, type
 */
export interface NexusSendResponse {
  readonly message_id: string;
  readonly path: string;
  readonly sender: string;
  readonly recipient: string;
  readonly type: string;
}

/**
 * On-disk message envelope — the full message as stored/read from Nexus.
 *
 * Matches MessageEnvelope (envelope.py) serialized with by_alias=True:
 *   id, from, to, type, correlation_id, timestamp, ttl_seconds, payload, ...
 *
 * Note: Pydantic aliases mean "sender"→"from", "recipient"→"to" in JSON.
 */
export interface NexusMessageEnvelope {
  readonly id: string;
  /** Sender agent ID — serialized as "from" on disk via Pydantic alias. */
  readonly from: string;
  /** Recipient agent ID — serialized as "to" on disk via Pydantic alias. */
  readonly to: string;
  readonly type: string;
  readonly correlation_id?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly ttl_seconds?: number | undefined;
  readonly payload: Record<string, unknown>;
  readonly nexus_message?: string | undefined;
  readonly signature?: string | undefined;
}

/**
 * Inbox list response — GET /api/v2/ipc/inbox/{agentId}.
 *
 * The REST compatibility endpoint returns filenames, not full envelopes.
 * Full message reading requires the RPC service.
 */
interface NexusInboxResponse {
  readonly agent_id: string;
  readonly messages: readonly { readonly filename: string }[];
  readonly count: number;
}

interface NexusInboxCountResponse {
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export interface NexusClientConfig {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly authToken?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Client interface (for testability)
// ---------------------------------------------------------------------------

export interface NexusClient {
  readonly sendMessage: (request: NexusSendRequest) => Promise<Result<NexusSendResponse, KoiError>>;
  readonly listInbox: (
    agentId: string,
    limit?: number,
    offset?: number,
  ) => Promise<Result<readonly NexusMessageEnvelope[], KoiError>>;
  readonly inboxCount: (agentId: string) => Promise<Result<number, KoiError>>;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapHttpError(status: number, body: string, context: string): KoiError {
  if (status === 404) {
    return {
      code: "NOT_FOUND",
      message: `${context}: resource not found`,
      retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
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

function mapFetchError(err: unknown, context: string): KoiError {
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

export function createNexusClient(config?: NexusClientConfig): NexusClient {
  const baseUrl = config?.baseUrl ?? DEFAULT_NEXUS_BASE_URL;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authToken = config?.authToken;
  const fetchFn = config?.fetch ?? globalThis.fetch;

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
        return { ok: false, error: mapHttpError(resp.status, text, context) };
      }

      // 204 No Content — return void-typed result
      if (resp.status === 204) {
        return { ok: true, value: undefined as T };
      }

      const json = (await resp.json()) as T;
      return { ok: true, value: json };
    } catch (e: unknown) {
      return { ok: false, error: mapFetchError(e, context) };
    }
  }

  return {
    sendMessage: async (req) => {
      return request<NexusSendResponse>("POST", "/api/v2/ipc/send", req);
    },

    listInbox: async (agentId, limit, offset) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      const qs = params.toString();
      const path = `/api/v2/ipc/inbox/${encodeURIComponent(agentId)}${qs.length > 0 ? `?${qs}` : ""}`;

      // The REST compatibility endpoint returns filenames, not full envelopes.
      // Return an empty array — full message content requires the Nexus RPC
      // service which is not exposed via REST. The inbox middleware relies on
      // SSE push notifications (not polling) for real-time message delivery.
      const result = await request<NexusInboxResponse>("GET", path);
      if (!result.ok) return result;

      // The response has {messages: [{filename}]} — no envelope content.
      // Return empty: callers should use SSE/onMessage for receiving messages.
      return { ok: true, value: [] };
    },

    inboxCount: async (agentId) => {
      const path = `/api/v2/ipc/inbox/${encodeURIComponent(agentId)}/count`;
      const result = await request<NexusInboxCountResponse>("GET", path);
      if (!result.ok) return result;
      return { ok: true, value: result.value.count };
    },
  };
}

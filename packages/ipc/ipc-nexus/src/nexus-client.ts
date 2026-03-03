/**
 * Thin HTTP client for the Nexus IPC REST API.
 *
 * All wire types (NexusMessageEnvelope, NexusSendRequest) are local to this
 * module — they never leak into L0 or the public API.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { DEFAULT_NEXUS_BASE_URL, DEFAULT_TIMEOUT_MS } from "./constants.js";

// ---------------------------------------------------------------------------
// Wire types (local — Nexus REST API envelope)
// ---------------------------------------------------------------------------

export interface NexusMessageEnvelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly correlationId?: string | undefined;
  readonly createdAt: string;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface NexusSendRequest {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly correlationId?: string | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

interface NexusInboxResponse {
  readonly messages: readonly NexusMessageEnvelope[];
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
  readonly sendMessage: (
    request: NexusSendRequest,
  ) => Promise<Result<NexusMessageEnvelope, KoiError>>;
  readonly listInbox: (
    agentId: string,
    limit?: number,
    offset?: number,
  ) => Promise<Result<readonly NexusMessageEnvelope[], KoiError>>;
  readonly inboxCount: (agentId: string) => Promise<Result<number, KoiError>>;
  readonly provision: (agentId: string) => Promise<Result<void, KoiError>>;
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
      const result = await request<NexusMessageEnvelope>("POST", "/api/v2/ipc/send", req);
      return result;
    },

    listInbox: async (agentId, limit, offset) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      const qs = params.toString();
      const path = `/api/v2/ipc/inbox/${encodeURIComponent(agentId)}${qs.length > 0 ? `?${qs}` : ""}`;
      const result = await request<NexusInboxResponse>("GET", path);
      if (!result.ok) return result;
      return { ok: true, value: result.value.messages };
    },

    inboxCount: async (agentId) => {
      const path = `/api/v2/ipc/inbox/${encodeURIComponent(agentId)}/count`;
      const result = await request<NexusInboxCountResponse>("GET", path);
      if (!result.ok) return result;
      return { ok: true, value: result.value.count };
    },

    provision: async (agentId) => {
      const path = `/api/v2/ipc/provision/${encodeURIComponent(agentId)}`;
      return request<void>("POST", path);
    },
  };
}

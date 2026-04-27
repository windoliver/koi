import type { DelegationId, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Wire types (Nexus API shape)
// ---------------------------------------------------------------------------

export type NexusNamespaceMode = "COPY" | "CLEAN" | "SHARED";

export interface NexusDelegateScope {
  readonly allowed_operations: readonly string[];
  readonly remove_grants: readonly string[];
  readonly scope_prefix?: string | undefined;
  readonly resource_patterns?: readonly string[] | undefined;
}

export interface NexusDelegateRequest {
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly scope: NexusDelegateScope;
  readonly namespace_mode: NexusNamespaceMode;
  readonly max_depth: number;
  readonly ttl_seconds: number;
  readonly can_sub_delegate: boolean;
  readonly idempotency_key: string;
}

export interface NexusDelegateResponse {
  readonly delegation_id: string;
  readonly api_key: string;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface NexusChainVerifyResponse {
  readonly delegation_id: string;
  readonly valid: boolean;
  readonly reason?: string | undefined;
  readonly chain_depth: number;
  readonly scope?: NexusDelegateScope | undefined;
}

export interface NexusDelegationEntry {
  readonly delegation_id: string;
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly namespace_mode: NexusNamespaceMode;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface NexusDelegationListResponse {
  readonly delegations: readonly NexusDelegationEntry[];
  readonly total: number;
  readonly cursor?: string | undefined;
}

// ---------------------------------------------------------------------------
// API interface
// ---------------------------------------------------------------------------

export interface NexusDelegationApi {
  readonly createDelegation: (
    req: NexusDelegateRequest,
  ) => Promise<Result<NexusDelegateResponse, KoiError>>;
  readonly revokeDelegation: (id: DelegationId) => Promise<Result<void, KoiError>>;
  readonly verifyChain: (id: DelegationId) => Promise<Result<NexusChainVerifyResponse, KoiError>>;
  readonly listDelegations: (
    cursor?: string,
  ) => Promise<Result<NexusDelegationListResponse, KoiError>>;
}

// ---------------------------------------------------------------------------
// Config & factory
// ---------------------------------------------------------------------------

export interface NexusDelegationApiConfig {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly deadlineMs?: number | undefined;
}

const DEFAULT_DEADLINE_MS = 45_000;
const BASE = "/api/v2/agents/delegate";

function mapHttpError(status: number, method: string): KoiError {
  const retryable = status === 429 || status >= 500;
  const code: KoiError["code"] =
    status === 404 ? "NOT_FOUND" : status === 401 || status === 403 ? "PERMISSION" : "INTERNAL";
  return {
    code,
    message: `Nexus ${method} failed: HTTP ${status}`,
    retryable,
    context: { status },
  };
}

export function createNexusDelegationApi(config: NexusDelegationApiConfig): NexusDelegationApi {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;

  function authHeaders(): Record<string, string> {
    return config.apiKey !== undefined ? { Authorization: `Bearer ${config.apiKey}` } : {};
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Result<T, KoiError>> {
    const signal = AbortSignal.timeout(deadlineMs);
    try {
      const res = await fetchFn(`${config.url}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      // 404 on DELETE → idempotent success
      if (method === "DELETE" && res.status === 404) {
        return { ok: true, value: undefined as unknown as T };
      }
      if (!res.ok) return { ok: false, error: mapHttpError(res.status, method) };
      // 204 No Content → void success
      if (res.status === 204) return { ok: true, value: undefined as unknown as T };
      const json = (await res.json()) as unknown as T;
      return { ok: true, value: json };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Nexus ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
          context: { method, path },
        },
      };
    }
  }

  return {
    createDelegation: (req) => request<NexusDelegateResponse>("POST", BASE, req),
    revokeDelegation: (id) => request<void>("DELETE", `${BASE}/${id}`),
    verifyChain: (id) => request<NexusChainVerifyResponse>("GET", `${BASE}/${id}/chain`),
    listDelegations: (cursor) => {
      const q = cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return request<NexusDelegationListResponse>("GET", `${BASE}${q}`);
    },
  };
}

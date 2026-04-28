import type { DelegationId, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Wire types (Nexus v2 API shape)
// ---------------------------------------------------------------------------

export type NexusNamespaceMode = "copy" | "clean" | "shared";

/**
 * Optional fine-grained scope constraints (DelegationScopeModel in OpenAPI).
 * Sent inside DelegateRequest.scope.
 */
export interface NexusDelegationScopeModel {
  readonly allowed_operations?: readonly string[] | undefined;
  readonly resource_patterns?: readonly string[] | undefined;
  readonly budget_limit?: string | null | undefined;
  readonly max_depth?: number | undefined;
}

/**
 * Wire-format request for POST /api/v2/agents/delegate.
 *
 * Parent identity is inferred from the API key — there is no `parent_agent_id`
 * field. There is no `max_depth` at the top level (it lives on the optional
 * scope object). Idempotency may be passed via header by the transport layer.
 */
export interface NexusDelegateRequest {
  readonly worker_id: string;
  readonly worker_name: string;
  readonly namespace_mode: NexusNamespaceMode;
  readonly remove_grants?: readonly string[] | null | undefined;
  readonly add_grants?: readonly string[] | null | undefined;
  readonly readonly_paths?: readonly string[] | null | undefined;
  readonly scope_prefix?: string | null | undefined;
  readonly ttl_seconds?: number | null | undefined;
  readonly intent?: string | undefined;
  readonly can_sub_delegate?: boolean | undefined;
  readonly scope?: NexusDelegationScopeModel | null | undefined;
  readonly auto_warmup?: boolean | undefined;
}

/**
 * Wire-format response for POST /api/v2/agents/delegate.
 */
export interface NexusDelegateResponse {
  readonly delegation_id: string;
  readonly worker_agent_id: string;
  readonly api_key: string;
  readonly mount_table: readonly string[];
  readonly expires_at: string | null;
  readonly delegation_mode: string;
  readonly warmup_success?: boolean | null | undefined;
}

/**
 * Single node in a delegation chain.
 */
export interface NexusDelegationChainItem {
  readonly delegation_id: string;
  readonly agent_id: string;
  readonly parent_agent_id: string;
  readonly delegation_mode: string;
  readonly status: string;
  readonly depth: number;
  readonly intent: string;
  readonly created_at: string;
}

/**
 * Wire-format response for GET /api/v2/agents/delegate/{id}/chain.
 */
export interface NexusDelegationChainResponse {
  readonly chain: readonly NexusDelegationChainItem[];
  readonly total_depth: number;
}

/**
 * Wire-format entry returned from GET /api/v2/agents/delegate (list).
 */
export interface NexusDelegationEntry {
  readonly delegation_id: string;
  readonly agent_id: string;
  readonly parent_agent_id: string;
  readonly delegation_mode: string;
  readonly status: string;
  readonly scope_prefix: string | null;
  readonly lease_expires_at: string | null;
  readonly zone_id: string | null;
  readonly intent: string;
  readonly depth: number;
  readonly can_sub_delegate: boolean;
  readonly created_at: string;
}

/**
 * Wire-format response for GET /api/v2/agents/delegate (paginated list).
 */
export interface NexusDelegationListResponse {
  readonly delegations: readonly NexusDelegationEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

// ---------------------------------------------------------------------------
// API interface
// ---------------------------------------------------------------------------

export interface NexusDelegationListParams {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface NexusDelegationApi {
  readonly createDelegation: (
    req: NexusDelegateRequest,
    options?: { readonly idempotencyKey?: string | undefined } | undefined,
  ) => Promise<Result<NexusDelegateResponse, KoiError>>;
  readonly revokeDelegation: (id: DelegationId) => Promise<Result<void, KoiError>>;
  readonly verifyChain: (
    id: DelegationId,
  ) => Promise<Result<NexusDelegationChainResponse, KoiError>>;
  readonly listDelegations: (
    params?: NexusDelegationListParams,
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
    extraHeaders?: Record<string, string>,
  ): Promise<Result<T, KoiError>> {
    const signal = AbortSignal.timeout(deadlineMs);
    try {
      const res = await fetchFn(`${config.url}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
          ...(extraHeaders ?? {}),
        },
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
    createDelegation: (req, options) => {
      const headers =
        options?.idempotencyKey !== undefined
          ? { "Idempotency-Key": options.idempotencyKey }
          : undefined;
      return request<NexusDelegateResponse>("POST", BASE, req, headers);
    },
    revokeDelegation: (id) => request<void>("DELETE", `${BASE}/${id}`),
    verifyChain: (id) => request<NexusDelegationChainResponse>("GET", `${BASE}/${id}/chain`),
    listDelegations: (params) => {
      const qs = new URLSearchParams();
      if (params?.limit !== undefined) qs.set("limit", String(params.limit));
      if (params?.offset !== undefined) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<NexusDelegationListResponse>("GET", `${BASE}${q.length > 0 ? `?${q}` : ""}`);
    },
  };
}

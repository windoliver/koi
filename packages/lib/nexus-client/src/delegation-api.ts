/**
 * Nexus delegation REST API — typed methods for /api/v2/agents/delegate endpoints.
 *
 * L0u utility — depends only on @koi/core types.
 */

import type { DelegationId, KoiError, Result } from "@koi/core";

import type { NexusRestClient } from "./rest-client.js";

// ---------------------------------------------------------------------------
// Request/Response types (Nexus API shape)
// ---------------------------------------------------------------------------

/** Nexus namespace isolation mode for delegated agents. */
export type NexusNamespaceMode = "COPY" | "CLEAN" | "SHARED";

/** Request body for POST /api/v2/agents/delegate */
export interface NexusDelegateRequest {
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly scope: NexusDelegateScope;
  readonly namespace_mode: NexusNamespaceMode;
  readonly max_depth: number;
  readonly ttl_seconds: number;
  readonly can_sub_delegate: boolean;
  /** Deterministic idempotency key — prevents duplicate grants on retry. */
  readonly idempotency_key: string;
}

export interface NexusDelegateScope {
  readonly allowed_operations: readonly string[];
  readonly remove_grants: readonly string[];
  readonly scope_prefix?: string | undefined;
  readonly resource_patterns?: readonly string[] | undefined;
  readonly readonly_paths?: readonly string[] | undefined;
}

/** Response from POST /api/v2/agents/delegate */
export interface NexusDelegateResponse {
  readonly delegation_id: string;
  readonly api_key: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/** Response from GET /api/v2/agents/delegate/{id}/chain */
export interface NexusChainVerifyResponse {
  readonly delegation_id: string;
  readonly valid: boolean;
  readonly reason?: string | undefined;
  readonly chain_depth: number;
  /** Scope data from the grant — enables cross-node scope enforcement. */
  readonly scope?: NexusDelegateScope | undefined;
}

/** A single delegation entry from GET /api/v2/agents/delegate */
export interface NexusDelegationEntry {
  readonly delegation_id: string;
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly namespace_mode: NexusNamespaceMode;
  readonly created_at: string;
  readonly expires_at: string;
}

/** Paginated response from GET /api/v2/agents/delegate */
export interface NexusDelegationListResponse {
  readonly delegations: readonly NexusDelegationEntry[];
  readonly total: number;
  readonly cursor?: string | undefined;
}

/** Outcome for POST /api/v2/agents/delegate/{id}/outcome */
export type DelegationOutcome = "completed" | "failed" | "timeout";

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export interface NexusDelegationApi {
  /** Create a delegation grant. Idempotent — same idempotency_key returns existing grant. */
  readonly createDelegation: (
    request: NexusDelegateRequest,
  ) => Promise<Result<NexusDelegateResponse, KoiError>>;

  /** Revoke a delegation. Nexus handles cascading internally. */
  readonly revokeDelegation: (delegationId: DelegationId) => Promise<Result<void, KoiError>>;

  /** Verify delegation chain integrity. Server-side — single call, no N+1. */
  readonly verifyChain: (
    delegationId: DelegationId,
  ) => Promise<Result<NexusChainVerifyResponse, KoiError>>;

  /** List active delegations for the authenticated agent. */
  readonly listDelegations: (
    cursor?: string,
  ) => Promise<Result<NexusDelegationListResponse, KoiError>>;

  /** Record delegation outcome — feeds Nexus reputation (Phase 4 seam). */
  readonly recordOutcome: (
    delegationId: DelegationId,
    outcome: DelegationOutcome,
  ) => Promise<Result<void, KoiError>>;
}

const DELEGATE_BASE = "/api/v2/agents/delegate";

/** Create a typed delegation API client backed by a NexusRestClient. */
export function createNexusDelegationApi(client: NexusRestClient): NexusDelegationApi {
  return {
    createDelegation: (request) =>
      client.request<NexusDelegateResponse>("POST", DELEGATE_BASE, request),

    revokeDelegation: (delegationId) =>
      client.request<void>("DELETE", `${DELEGATE_BASE}/${delegationId}`),

    verifyChain: (delegationId) =>
      client.request<NexusChainVerifyResponse>("GET", `${DELEGATE_BASE}/${delegationId}/chain`),

    listDelegations: (cursor) => {
      const query = cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return client.request<NexusDelegationListResponse>("GET", `${DELEGATE_BASE}${query}`);
    },

    recordOutcome: (delegationId, outcome) =>
      client.request<void>("POST", `${DELEGATE_BASE}/${delegationId}/outcome`, {
        outcome,
      }),
  };
}

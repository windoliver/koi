/**
 * NexusDelegationBackend — implements DelegationComponent backed by Nexus REST API.
 *
 * L0u package — imports from @koi/core (L0) and @koi/nexus-client (L0u) only.
 */

import type {
  AgentId,
  DelegationComponent,
  DelegationGrant,
  DelegationId,
  DelegationScope,
  DelegationVerifyResult,
  NamespaceMode,
} from "@koi/core";
import { delegationId } from "@koi/core";
import type { NexusDelegateRequest, NexusDelegationApi } from "@koi/nexus-client";
import { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";
import type { TtlVerifyCache } from "./ttl-verify-cache.js";
import { createTtlVerifyCache } from "./ttl-verify-cache.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusDelegationBackendConfig {
  /** The Nexus delegation API client. */
  readonly api: NexusDelegationApi;
  /** Agent ID of the owning agent (issuer). */
  readonly agentId: AgentId;
  /** Maximum chain depth for delegation. Default: 3. */
  readonly maxChainDepth?: number;
  /** Default grant TTL in seconds. Default: 3600 (1 hour). */
  readonly defaultTtlSeconds?: number;
  /** Namespace mode for new delegations. Default: "copy". */
  readonly namespaceMode?: NamespaceMode;
  /** Whether child agents can sub-delegate. Default: true. */
  readonly canSubDelegate?: boolean;
  /** Verify cache TTL in milliseconds. Default: 30_000 (30s). 0 = no caching. */
  readonly verifyCacheTtlMs?: number;
  /** Idempotency key prefix — combined with child ID for deterministic keys. */
  readonly idempotencyPrefix?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHAIN_DEPTH = 3;
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Create a NexusDelegationBackend implementing DelegationComponent.
 *
 * Uses the Nexus REST API for durable, cross-node delegation:
 * - grant() -> POST /api/v2/agents/delegate (idempotent via idempotency_key)
 * - revoke() -> DELETE /api/v2/agents/delegate/{id}
 * - verify() -> GET /api/v2/agents/delegate/{id}/chain (server-side, no N+1)
 * - list() -> GET /api/v2/agents/delegate (paginated, aggregated)
 */
export function createNexusDelegationBackend(
  config: NexusDelegationBackendConfig,
): DelegationComponent {
  const {
    api,
    agentId,
    maxChainDepth = DEFAULT_MAX_CHAIN_DEPTH,
    defaultTtlSeconds = DEFAULT_TTL_SECONDS,
    namespaceMode,
    canSubDelegate = true,
    verifyCacheTtlMs = 30_000,
    idempotencyPrefix = "",
  } = config;

  const verifyCache: TtlVerifyCache | undefined =
    verifyCacheTtlMs > 0 ? createTtlVerifyCache({ ttlMs: verifyCacheTtlMs }) : undefined;

  /**
   * Compute a deterministic idempotency key for delegation grants.
   * Ensures Temporal activity retries don't create duplicate delegations.
   */
  function computeIdempotencyKey(delegateeId: AgentId): string {
    return `${idempotencyPrefix}${agentId}:${delegateeId}`;
  }

  async function grant(
    scope: DelegationScope,
    delegateeId: AgentId,
    ttlMs?: number,
  ): Promise<DelegationGrant> {
    const ttlSeconds = ttlMs !== undefined ? Math.ceil(ttlMs / 1000) : defaultTtlSeconds;

    const request: NexusDelegateRequest = {
      parent_agent_id: agentId,
      child_agent_id: delegateeId,
      scope: mapScopeToNexus(scope),
      namespace_mode: mapNamespaceMode(namespaceMode),
      max_depth: maxChainDepth,
      ttl_seconds: ttlSeconds,
      can_sub_delegate: canSubDelegate && maxChainDepth > 0,
      idempotency_key: computeIdempotencyKey(delegateeId),
    };

    const result = await api.createDelegation(request);
    if (!result.ok) {
      throw new Error(`Nexus delegation grant failed: ${result.error.message}`);
    }

    const resp = result.value;
    const now = Date.now();

    // Map Nexus response back to DelegationGrant (L0 type)
    return {
      id: delegationId(resp.delegation_id),
      issuerId: agentId,
      delegateeId,
      scope,
      chainDepth: 0,
      maxChainDepth,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      proof: { kind: "nexus", token: resp.api_key },
    };
  }

  async function revoke(id: DelegationId, _cascade?: boolean): Promise<void> {
    // Nexus handles cascading revocation server-side — the cascade flag
    // is implicit (Nexus always cascades). We still accept it for interface compat.
    const result = await api.revokeDelegation(id);
    if (!result.ok && result.error.code !== "NOT_FOUND") {
      // NOT_FOUND on revoke is idempotent — already revoked
      throw new Error(`Nexus delegation revoke failed: ${result.error.message}`);
    }
    verifyCache?.invalidate(id);
  }

  async function verify(id: DelegationId, toolId: string): Promise<DelegationVerifyResult> {
    // Fast path — serve from cache (including stale entries)
    if (verifyCache !== undefined) {
      const cached = verifyCache.get(id, toolId);
      if (cached !== undefined && !verifyCache.isStale(id, toolId)) {
        return cached;
      }

      // Stale entry — serve it but trigger background refresh
      if (cached !== undefined && verifyCache.isStale(id, toolId)) {
        void refreshVerifyCache(id, toolId);
        return cached;
      }
    }

    // Cache miss — synchronous Nexus call
    return verifyFromNexus(id, toolId);
  }

  async function verifyFromNexus(
    id: DelegationId,
    toolId: string,
  ): Promise<DelegationVerifyResult> {
    const result = await api.verifyChain(id);

    if (!result.ok) {
      const failResult: DelegationVerifyResult = {
        ok: false,
        reason: result.error.code === "NOT_FOUND" ? "unknown_grant" : "invalid_signature",
      };
      verifyCache?.set(id, toolId, failResult);
      return failResult;
    }

    const chainResult = result.value;
    if (!chainResult.valid) {
      const reason = mapNexusReason(chainResult.reason);
      const failResult: DelegationVerifyResult = { ok: false, reason };
      verifyCache?.set(id, toolId, failResult);
      return failResult;
    }

    // Chain is valid — construct a minimal grant for the result
    // The full grant isn't available from the chain endpoint, so we
    // construct a stub with the verified delegation ID.
    const successResult: DelegationVerifyResult = {
      ok: true,
      grant: {
        id,
        issuerId: agentId,
        delegateeId: agentId, // Placeholder — caller already knows the delegatee
        scope: { permissions: {} },
        chainDepth: chainResult.chain_depth,
        maxChainDepth,
        createdAt: 0,
        expiresAt: 0,
        proof: { kind: "nexus", token: "" },
      },
    };
    verifyCache?.set(id, toolId, successResult);
    return successResult;
  }

  async function refreshVerifyCache(id: DelegationId, toolId: string): Promise<void> {
    try {
      await verifyFromNexus(id, toolId);
    } catch {
      // Background refresh failure — stale entry continues to serve
    }
  }

  async function list(): Promise<readonly DelegationGrant[]> {
    const grants: DelegationGrant[] = [];
    let cursor: string | undefined;

    // Paginate through all active delegations
    do {
      const result = await api.listDelegations(cursor);
      if (!result.ok) {
        throw new Error(`Nexus delegation list failed: ${result.error.message}`);
      }

      for (const entry of result.value.delegations) {
        grants.push({
          id: delegationId(entry.delegation_id),
          issuerId: agentId,
          delegateeId: entry.child_agent_id as AgentId,
          scope: { permissions: {} },
          chainDepth: 0,
          maxChainDepth,
          createdAt: new Date(entry.created_at).getTime(),
          expiresAt: new Date(entry.expires_at).getTime(),
          proof: { kind: "nexus", token: "" },
        });
      }

      cursor = result.value.cursor;
    } while (cursor !== undefined);

    return grants;
  }

  return { grant, revoke, verify, list };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapNexusReason(
  reason: string | undefined,
):
  | "expired"
  | "revoked"
  | "scope_exceeded"
  | "chain_depth_exceeded"
  | "invalid_signature"
  | "unknown_grant" {
  switch (reason) {
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "scope_exceeded":
      return "scope_exceeded";
    case "chain_depth_exceeded":
      return "chain_depth_exceeded";
    case "unknown":
    case "not_found":
      return "unknown_grant";
    default:
      return "invalid_signature";
  }
}

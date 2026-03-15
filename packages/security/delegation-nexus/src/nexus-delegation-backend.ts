/**
 * NexusDelegationBackend — implements DelegationComponent backed by Nexus REST API.
 *
 * L0u package — imports from @koi/core (L0) and @koi/nexus-client (L0u) only.
 *
 * Design decisions:
 * - #2-A: Idempotency key on grant() — uses random nonce for general API,
 *   Temporal activities pass their own deterministic key via idempotencyPrefix
 * - #3: verify() enforces scope locally after Nexus chain verification
 * - #13-A: TTL verify cache with stale-while-revalidate
 * - #14-A: Server-side chain verification via /chain endpoint (no N+1)
 * - #15-A: Shared NexusDelegationApi instance (single connection pool)
 */

import { randomUUID } from "node:crypto";
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
  /** The Nexus delegation API client (shared — single HTTP connection pool, #15-A). */
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
  /**
   * Idempotency key prefix for Temporal activity retries.
   * When set, grant() uses `prefix + agentId:delegateeId` (deterministic for retries).
   * When absent, grant() uses a random UUID (safe for general DelegationComponent API).
   */
  readonly idempotencyPrefix?: string;
}

// ---------------------------------------------------------------------------
// Scope matching (local enforcement — Nexus verifies chain, we verify tool)
// ---------------------------------------------------------------------------

/**
 * Check whether a tool invocation is allowed by the delegation scope.
 * Mirrors the in-memory backend's matchToolAgainstScope logic.
 */
function matchToolAgainstScope(toolId: string, scope: DelegationScope): boolean {
  const allowList = scope.permissions.allow ?? [];
  const denyList = scope.permissions.deny ?? [];

  // Extract tool name (before ':' if resource path present)
  const colonIdx = toolId.indexOf(":");
  const toolName = colonIdx >= 0 ? toolId.slice(0, colonIdx) : toolId;

  // Deny overrides allow
  if (denyList.includes(toolName) || denyList.includes(toolId)) {
    return false;
  }

  // Must match allow list
  return allowList.includes(toolName) || allowList.includes("*");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHAIN_DEPTH = 3;
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Create a NexusDelegationBackend implementing DelegationComponent.
 *
 * Backed by Nexus REST API for durable, cross-node delegation:
 * - grant()  → POST /api/v2/agents/delegate (idempotent via idempotency_key)
 * - revoke() → DELETE /api/v2/agents/delegate/{id} (Nexus cascades)
 * - verify() → GET /api/v2/agents/delegate/{id}/chain + LOCAL scope check
 * - list()   → GET /api/v2/agents/delegate (paginated, aggregated)
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
    idempotencyPrefix,
  } = config;

  const verifyCache: TtlVerifyCache | undefined =
    verifyCacheTtlMs > 0 ? createTtlVerifyCache({ ttlMs: verifyCacheTtlMs }) : undefined;

  // Local grant store — caches grant data (scope, expiry) from grant() for
  // verify() scope enforcement. Nexus verifies chain integrity; we verify
  // tool-level permission locally using the cached scope.
  const grantStore = new Map<DelegationId, DelegationGrant>();

  /**
   * Compute idempotency key for Nexus API.
   * - With prefix (Temporal path): deterministic — retries return same grant
   * - Without prefix (general API): random UUID — each grant() is unique
   */
  function computeIdempotencyKey(delegateeId: AgentId): string {
    if (idempotencyPrefix !== undefined) {
      return `${idempotencyPrefix}${agentId}:${delegateeId}`;
    }
    return randomUUID();
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

    const delegGrant: DelegationGrant = {
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

    // Cache grant locally for scope enforcement during verify()
    grantStore.set(delegGrant.id, delegGrant);

    return delegGrant;
  }

  async function revoke(id: DelegationId, _cascade?: boolean): Promise<void> {
    const result = await api.revokeDelegation(id);
    if (!result.ok && result.error.code !== "NOT_FOUND") {
      throw new Error(`Nexus delegation revoke failed: ${result.error.message}`);
    }
    grantStore.delete(id);
    verifyCache?.invalidate(id);
  }

  async function verify(id: DelegationId, toolId: string): Promise<DelegationVerifyResult> {
    // Fast path — serve from cache if fresh
    if (verifyCache !== undefined) {
      const cached = verifyCache.get(id, toolId);
      if (cached !== undefined && !verifyCache.isStale(id, toolId)) {
        return cached;
      }

      // Stale entry — serve it and trigger background refresh (#13-A)
      if (cached !== undefined && verifyCache.isStale(id, toolId)) {
        void refreshVerifyCache(id, toolId);
        return cached;
      }
    }

    return verifyFromNexus(id, toolId);
  }

  async function verifyFromNexus(
    id: DelegationId,
    toolId: string,
  ): Promise<DelegationVerifyResult> {
    // Step 1: Local scope check — fail fast before Nexus round-trip
    const storedGrant = grantStore.get(id);
    if (storedGrant !== undefined) {
      // Check expiry locally
      if (storedGrant.expiresAt <= Date.now()) {
        const failResult: DelegationVerifyResult = { ok: false, reason: "expired" };
        verifyCache?.set(id, toolId, failResult);
        grantStore.delete(id);
        return failResult;
      }

      // Check tool against scope locally
      if (!matchToolAgainstScope(toolId, storedGrant.scope)) {
        const failResult: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
        verifyCache?.set(id, toolId, failResult);
        return failResult;
      }
    }

    // Step 2: Nexus chain verification (crypto, revocation, chain integrity)
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

    // Chain valid + scope check passed — return full grant from local store
    const resultGrant = storedGrant ?? {
      id,
      issuerId: agentId,
      delegateeId: agentId,
      scope: { permissions: {} },
      chainDepth: chainResult.chain_depth,
      maxChainDepth,
      createdAt: 0,
      expiresAt: 0,
      proof: { kind: "nexus" as const, token: "" },
    };

    const successResult: DelegationVerifyResult = { ok: true, grant: resultGrant };
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

    do {
      const result = await api.listDelegations(cursor);
      if (!result.ok) {
        throw new Error(`Nexus delegation list failed: ${result.error.message}`);
      }

      for (const entry of result.value.delegations) {
        const entryId = delegationId(entry.delegation_id);
        // Prefer local grant data (has scope) over Nexus list data (scope-less)
        const local = grantStore.get(entryId);
        grants.push(
          local ?? {
            id: entryId,
            issuerId: agentId,
            delegateeId: entry.child_agent_id as AgentId,
            scope: { permissions: {} },
            chainDepth: 0,
            maxChainDepth,
            createdAt: new Date(entry.created_at).getTime(),
            expiresAt: new Date(entry.expires_at).getTime(),
            proof: { kind: "nexus", token: "" },
          },
        );
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

type DenyReason =
  | "expired"
  | "revoked"
  | "scope_exceeded"
  | "chain_depth_exceeded"
  | "invalid_signature"
  | "unknown_grant";

function mapNexusReason(reason: string | undefined): DenyReason {
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

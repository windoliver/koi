import { randomUUID } from "node:crypto";
import type {
  AgentId,
  DelegationComponent,
  DelegationDenyReason,
  DelegationGrant,
  DelegationId,
  DelegationScope,
  DelegationVerifyResult,
  NamespaceMode,
} from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import type { NexusDelegationApi } from "./delegation-api.js";
import { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";
import type { TtlVerifyCache } from "./ttl-verify-cache.js";
import { createTtlVerifyCache } from "./ttl-verify-cache.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusDelegationBackendConfig {
  readonly api: NexusDelegationApi;
  readonly agentId: AgentId;
  readonly maxChainDepth?: number;
  readonly defaultTtlSeconds?: number;
  readonly namespaceMode?: NamespaceMode;
  readonly canSubDelegate?: boolean;
  readonly verifyCacheTtlMs?: number;
  readonly idempotencyPrefix?: string;
  readonly maxPendingRevocations?: number;
  readonly maxRevocationRetries?: number;
}

// ---------------------------------------------------------------------------
// Retry queue (private)
// ---------------------------------------------------------------------------

interface PendingRevocation {
  readonly id: DelegationId;
  readonly childId: AgentId;
  readonly failedAt: number;
  readonly attempts: number;
}

// ---------------------------------------------------------------------------
// Scope enforcement helper
// ---------------------------------------------------------------------------

function matchTool(toolId: string, scope: DelegationScope): boolean {
  const allow = scope.permissions.allow ?? [];
  const deny = scope.permissions.deny ?? [];
  const colon = toolId.indexOf(":");
  const name = colon === -1 ? toolId : toolId.slice(0, colon);
  if (deny.includes(name) || deny.includes(toolId)) return false;
  return allow.includes(name) || allow.includes(toolId) || allow.includes("*");
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHAIN_DEPTH = 3;
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_VERIFY_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_PENDING = 100;
const DEFAULT_MAX_RETRIES = 5;
const UNKNOWN_AGENT_ID: AgentId = agentId("unknown");

// ---------------------------------------------------------------------------
// Reason mapping (private helper)
// ---------------------------------------------------------------------------

function mapNexusReason(reason: string | undefined): DelegationDenyReason {
  switch (reason) {
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "scope_exceeded":
      return "scope_exceeded";
    case "chain_depth_exceeded":
      return "chain_depth_exceeded";
    case "not_found":
    case "unknown":
      return "unknown_grant";
    default:
      return "invalid_signature";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusDelegationBackend(
  config: NexusDelegationBackendConfig,
): DelegationComponent {
  const {
    api,
    agentId: ownId,
    maxChainDepth = DEFAULT_MAX_CHAIN_DEPTH,
    defaultTtlSeconds = DEFAULT_TTL_SECONDS,
    namespaceMode,
    canSubDelegate = true,
    verifyCacheTtlMs = DEFAULT_VERIFY_CACHE_TTL_MS,
    idempotencyPrefix,
    maxPendingRevocations = DEFAULT_MAX_PENDING,
    maxRevocationRetries = DEFAULT_MAX_RETRIES,
  } = config;

  const verifyCache: TtlVerifyCache | undefined =
    verifyCacheTtlMs > 0 ? createTtlVerifyCache({ ttlMs: verifyCacheTtlMs }) : undefined;

  const grantStore = new Map<DelegationId, DelegationGrant>();
  // let is justified: the retry queue is a mutable bounded list rebuilt after each drain
  let pendingRevocations: PendingRevocation[] = [];

  // ---------------------------------------------------------------------------
  // Retry queue helpers
  // ---------------------------------------------------------------------------

  function enqueueRevocation(id: DelegationId, childId: AgentId): void {
    if (pendingRevocations.length >= maxPendingRevocations) {
      const dropped = pendingRevocations[0];
      pendingRevocations = pendingRevocations.slice(1);
      if (dropped !== undefined) {
        console.error(
          `[nexus-delegation] retry queue full — dropping oldest pending revocation (delegationId=${dropped.id})`,
          { delegationId: dropped.id, childId: dropped.childId, droppedAt: Date.now() },
        );
      }
    }
    pendingRevocations = [
      ...pendingRevocations,
      { id, childId, failedAt: Date.now(), attempts: 1 },
    ];
  }

  async function drainQueue(): Promise<void> {
    if (pendingRevocations.length === 0) return;
    const snapshot = pendingRevocations;
    pendingRevocations = [];
    const requeue: PendingRevocation[] = [];

    for (const entry of snapshot) {
      const result = await api.revokeDelegation(entry.id);
      if (result.ok) {
        grantStore.delete(entry.id);
        verifyCache?.invalidate(entry.id);
      } else if (entry.attempts >= maxRevocationRetries) {
        console.error(
          `[nexus-delegation] revocation failed after max retries — manual intervention required (delegationId=${entry.id})`,
          {
            delegationId: entry.id,
            childId: entry.childId,
            attempts: entry.attempts,
            error: result.error.message,
          },
        );
      } else {
        requeue.push({ ...entry, attempts: entry.attempts + 1 });
      }
    }

    pendingRevocations = [...requeue, ...pendingRevocations];
  }

  // ---------------------------------------------------------------------------
  // grant()
  // ---------------------------------------------------------------------------

  async function grant(
    scope: DelegationScope,
    delegateeId: AgentId,
    ttlMs?: number,
  ): Promise<DelegationGrant> {
    const ttlSeconds = ttlMs !== undefined ? Math.ceil(ttlMs / 1000) : defaultTtlSeconds;
    const idempotencyKey =
      idempotencyPrefix !== undefined
        ? `${idempotencyPrefix}${ownId}:${delegateeId}`
        : randomUUID();

    const result = await api.createDelegation({
      parent_agent_id: ownId,
      child_agent_id: delegateeId,
      scope: mapScopeToNexus(scope),
      namespace_mode: mapNamespaceMode(namespaceMode),
      max_depth: maxChainDepth,
      ttl_seconds: ttlSeconds,
      can_sub_delegate: canSubDelegate && maxChainDepth > 0,
      idempotency_key: idempotencyKey,
    });

    if (!result.ok) {
      throw new Error(`Nexus delegation grant failed: ${result.error.message}`);
    }

    const now = Date.now();
    const parsedCreatedAt = Date.parse(result.value.created_at);
    const parsedExpiresAt = Date.parse(result.value.expires_at);
    const createdAt = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : now;
    const expiresAt = Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : now + ttlSeconds * 1000;
    const g: DelegationGrant = {
      id: delegationId(result.value.delegation_id),
      issuerId: ownId,
      delegateeId,
      scope,
      chainDepth: 0,
      maxChainDepth,
      createdAt,
      expiresAt,
      proof: { kind: "nexus", token: result.value.api_key },
    };

    grantStore.set(g.id, g);
    return g;
  }

  // ---------------------------------------------------------------------------
  // revoke()
  // ---------------------------------------------------------------------------

  async function revoke(id: DelegationId, _cascade?: boolean): Promise<void> {
    // Trigger background drain of pending queue (opportunistic, non-blocking)
    void drainQueue();

    const storedGrant = grantStore.get(id);
    const result = await api.revokeDelegation(id);

    if (!result.ok) {
      const childId = storedGrant?.delegateeId ?? UNKNOWN_AGENT_ID;
      enqueueRevocation(id, childId);
      return;
    }

    grantStore.delete(id);
    verifyCache?.invalidate(id);
  }

  // ---------------------------------------------------------------------------
  // verify()
  // ---------------------------------------------------------------------------

  async function verifyFromNexus(
    id: DelegationId,
    toolId: string,
  ): Promise<DelegationVerifyResult> {
    const result = await api.verifyChain(id);

    if (!result.ok) {
      const r: DelegationVerifyResult = {
        ok: false,
        reason: result.error.code === "NOT_FOUND" ? "unknown_grant" : "invalid_signature",
      };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const chain = result.value;
    if (!chain.valid) {
      const reason = mapNexusReason(chain.reason);
      const r: DelegationVerifyResult = { ok: false, reason };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const stored = grantStore.get(id);
    let resolvedScope: DelegationScope | undefined;
    if (stored !== undefined) {
      resolvedScope = stored.scope;
    } else if (chain.scope !== undefined) {
      const baseScope: DelegationScope = {
        permissions: {
          allow: [...chain.scope.allowed_operations],
          deny: [...chain.scope.remove_grants],
        },
      };
      resolvedScope =
        chain.scope.resource_patterns !== undefined
          ? { ...baseScope, resources: [...chain.scope.resource_patterns] }
          : baseScope;
    }

    // Fail-closed: no scope available
    if (resolvedScope === undefined) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    // Cross-node scope enforcement (no local grant)
    if (stored === undefined && !matchTool(toolId, resolvedScope)) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const g: DelegationGrant = stored ?? {
      id,
      issuerId: ownId,
      delegateeId: ownId,
      scope: resolvedScope,
      chainDepth: chain.chain_depth,
      maxChainDepth,
      createdAt: 0,
      expiresAt: 0,
      proof: { kind: "nexus", token: "" },
    };

    const r: DelegationVerifyResult = { ok: true, grant: g };
    verifyCache?.set(id, toolId, r);
    return r;
  }

  async function verify(id: DelegationId, toolId: string): Promise<DelegationVerifyResult> {
    const stored = grantStore.get(id);

    // Local expiry fast path
    if (stored !== undefined && stored.expiresAt <= Date.now()) {
      const r: DelegationVerifyResult = { ok: false, reason: "expired" };
      verifyCache?.set(id, toolId, r);
      grantStore.delete(id);
      return r;
    }

    // Local scope fast path
    if (stored !== undefined && !matchTool(toolId, stored.scope)) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    // TTL cache (fresh hit, or stale -> serve-stale + background refresh)
    if (verifyCache !== undefined) {
      const cached = verifyCache.get(id, toolId);
      if (cached !== undefined && !verifyCache.isStale(id, toolId)) return cached;
      if (cached !== undefined) {
        // Stale — serve stale, background refresh
        void verifyFromNexus(id, toolId);
        return cached;
      }
    }

    return verifyFromNexus(id, toolId);
  }

  // ---------------------------------------------------------------------------
  // list()
  // ---------------------------------------------------------------------------

  async function list(): Promise<readonly DelegationGrant[]> {
    const grants: DelegationGrant[] = [];
    let cursor: string | undefined;

    do {
      const result = await api.listDelegations(cursor);
      if (!result.ok) {
        throw new Error(`Nexus delegation list failed: ${result.error.message}`);
      }

      for (const entry of result.value.delegations) {
        const eid = delegationId(entry.delegation_id);
        const local = grantStore.get(eid);
        if (local !== undefined) {
          grants.push(local);
          continue;
        }
        grants.push({
          id: eid,
          issuerId: ownId,
          delegateeId: agentId(entry.child_agent_id),
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

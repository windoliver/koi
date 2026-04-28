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
const DEFAULT_LIST_PAGE_SIZE = 50;
const UNKNOWN_AGENT_ID: AgentId = agentId("unknown");

// ---------------------------------------------------------------------------
// Reason mapping (private helpers)
// ---------------------------------------------------------------------------

/**
 * Map a Nexus chain item `status` string to a Koi deny reason. Active chain
 * leaves are valid; everything else maps to a deny reason.
 */
function chainStatusToDenyReason(status: string): DelegationDenyReason | undefined {
  switch (status) {
    case "active":
      return undefined;
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "completed":
      return "revoked";
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
    canSubDelegate = false,
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

    const adjustments = mapScopeToNexus(scope);

    const result = await api.createDelegation(
      {
        worker_id: delegateeId,
        worker_name: delegateeId,
        namespace_mode: mapNamespaceMode(namespaceMode),
        ttl_seconds: ttlSeconds,
        intent: "",
        can_sub_delegate: canSubDelegate && maxChainDepth > 0,
        ...(adjustments.add_grants.length > 0 ? { add_grants: adjustments.add_grants } : {}),
        ...(adjustments.remove_grants.length > 0
          ? { remove_grants: adjustments.remove_grants }
          : {}),
        ...(adjustments.readonly_paths.length > 0
          ? { readonly_paths: adjustments.readonly_paths }
          : {}),
        ...(scope.resources !== undefined && scope.resources.length > 0
          ? { scope: { resource_patterns: scope.resources, max_depth: maxChainDepth } }
          : {}),
      },
      { idempotencyKey },
    );

    if (!result.ok) {
      throw new Error(`Nexus delegation grant failed: ${result.error.message}`);
    }

    const now = Date.now();
    const expiresRaw = result.value.expires_at;
    const parsedExpiresAt = expiresRaw !== null ? Date.parse(expiresRaw) : Number.NaN;
    const expiresAt = Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : now + ttlSeconds * 1000;

    const g: DelegationGrant = {
      id: delegationId(result.value.delegation_id),
      issuerId: ownId,
      delegateeId,
      scope,
      chainDepth: 0,
      maxChainDepth,
      createdAt: now,
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
    // The chain endpoint traces from leaf (this delegation) → root. The first
    // item is the delegation we asked about. An empty chain = unknown_grant.
    const leaf = chain.chain[0];
    if (leaf === undefined) {
      const r: DelegationVerifyResult = { ok: false, reason: "unknown_grant" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const denyReason = chainStatusToDenyReason(leaf.status);
    if (denyReason !== undefined) {
      const r: DelegationVerifyResult = { ok: false, reason: denyReason };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    if (chain.total_depth > maxChainDepth) {
      const r: DelegationVerifyResult = { ok: false, reason: "chain_depth_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const stored = grantStore.get(id);
    // The chain endpoint does not return scope. Local store wins for scope
    // enforcement; if we have no local entry, we fail closed on scope.
    if (stored === undefined) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    if (!matchTool(toolId, stored.scope)) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const r: DelegationVerifyResult = { ok: true, grant: stored };
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
    const limit = DEFAULT_LIST_PAGE_SIZE;
    // let justified: paging cursor mutated until we've consumed all `total` records
    let offset = 0;
    // let justified: continuation flag toggled by break-condition at end of body
    let more = true;

    while (more) {
      const result = await api.listDelegations({ limit, offset });
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
        const expiresMs =
          entry.lease_expires_at !== null ? Date.parse(entry.lease_expires_at) : Number.NaN;
        const createdMs = Date.parse(entry.created_at);
        grants.push({
          id: eid,
          issuerId: agentId(entry.parent_agent_id),
          delegateeId: agentId(entry.agent_id),
          scope: { permissions: {} },
          chainDepth: entry.depth,
          maxChainDepth,
          createdAt: Number.isFinite(createdMs) ? createdMs : 0,
          expiresAt: Number.isFinite(expiresMs) ? expiresMs : 0,
          proof: { kind: "nexus", token: "" },
        });
      }

      offset += result.value.delegations.length;
      more = offset < result.value.total && result.value.delegations.length > 0;
    }

    return grants;
  }

  return { grant, revoke, verify, list };
}

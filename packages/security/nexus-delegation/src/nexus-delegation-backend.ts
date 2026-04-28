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
/** Total grant attempts (initial + retries) for transient/retryable errors. */
const GRANT_MAX_ATTEMPTS = 3;
/** Base delay between grant retries (linear backoff: 100ms, 200ms, 300ms…). */
const GRANT_RETRY_DELAY_MS = 100;

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
  // Tombstones for grants whose revoke() was observed. verify() must deny
  // immediately for tombstoned ids even if a positive cache entry would
  // otherwise authorize. Stored as id → expiresAt so the Set cannot grow
  // unbounded across a long-lived parent's lifetime — entries past their TTL
  // are GC'd lazily on every tombstone read or write. The TTL covers the
  // longest verify-cache lifetime + any in-flight refresh window: once those
  // expire, no positive cache entry remains and the local denial is no longer
  // load-bearing.
  const revokedTombstones = new Map<DelegationId, number>();
  const TOMBSTONE_TTL_MS = Math.max(verifyCacheTtlMs * 2, 60_000);

  function tombstoneSweep(now: number): void {
    for (const [id, expiresAt] of revokedTombstones) {
      if (expiresAt <= now) revokedTombstones.delete(id);
    }
  }

  function addTombstone(id: DelegationId): void {
    const now = Date.now();
    tombstoneSweep(now);
    revokedTombstones.set(id, now + TOMBSTONE_TTL_MS);
  }

  function hasTombstone(id: DelegationId): boolean {
    const expiresAt = revokedTombstones.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      revokedTombstones.delete(id);
      return false;
    }
    return true;
  }
  // let is justified: the retry queue is a mutable bounded list rebuilt after each drain
  let pendingRevocations: PendingRevocation[] = [];
  // Serializes drain with grant() so a same-id regrant cannot race an
  // in-flight drain that already snapshotted the queue. grant() awaits this
  // promise before installing into the grantStore, guaranteeing the drain's
  // grantStore.delete() lands first if it was about to fire for this id.
  // let is justified: chained on each new drain to enforce FIFO ordering
  let drainInProgress: Promise<void> = Promise.resolve();

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

  function drainQueue(): Promise<void> {
    // Chain off the current drainInProgress so concurrent drain triggers
    // serialize FIFO. grant() awaits this same promise before installing into
    // grantStore, closing the race where a drain snapshot could revoke a
    // freshly-issued same-id regrant.
    drainInProgress = drainInProgress.then(realDrain).catch(() => {});
    return drainInProgress;
  }

  async function realDrain(): Promise<void> {
    if (pendingRevocations.length === 0) return;
    const snapshot = pendingRevocations;
    pendingRevocations = [];
    const requeue: PendingRevocation[] = [];

    for (const entry of snapshot) {
      const result = await api.revokeDelegation(entry.id);
      if (result.ok) {
        grantStore.delete(entry.id);
        verifyCache?.invalidate(entry.id);
        // Tombstone is no longer needed once Nexus has accepted the revoke —
        // the canonical store agrees with our local denial. Drop it so the Set
        // does not grow unbounded for long-lived backends.
        revokedTombstones.delete(entry.id);
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
    // Idempotency key has two modes:
    //   - prefix-supplied  → DETERMINISTIC `${prefix}${parent}:${child}` (caller
    //     opt-in for cross-call dedup; the caller is responsible for ensuring
    //     `delegateeId` is unique-per-logical-spawn so two unrelated grants
    //     for the same pair don't collide. This mode lets a host that
    //     observes a `grant()` rejection retry with the same key and have
    //     Nexus reconcile a server-side-created-but-response-lost delegation
    //     onto a single grant.)
    //   - no prefix        → fresh `${parent}:${child}:${uuid}` per call (safe
    //     default for hosts that don't manage logical-spawn ids; prevents
    //     unintended dedup across separate grant() calls for the same pair).
    // Within either mode, the SAME key is reused across the internal retry
    // loop below so within-call lost-response races dedup onto one delegation.
    const idempotencyKey =
      idempotencyPrefix !== undefined
        ? `${idempotencyPrefix}${ownId}:${delegateeId}`
        : `${ownId}:${delegateeId}:${randomUUID()}`;

    // Drain any in-flight revocations BEFORE asking Nexus for a new delegation.
    //
    // The race we close: revoke(D) failed and enqueued; a drain is in-flight
    // DELETEing D in Nexus. If we POST createDelegation now and Nexus replays
    // the same delegation_id (deterministic idempotency, or Nexus internal
    // dedup window), the in-flight DELETE can complete AFTER our POST commits
    // — the freshly returned token is already revoked server-side, but we
    // would happily install it locally.
    //
    // Draining first ensures any prior id is dead in Nexus before POST, so
    // Nexus's idempotency cache for that id is invalidated and POST mints a
    // new delegation_id. Cheap when the queue is empty (already-resolved
    // promise).
    await drainInProgress;

    const adjustments = mapScopeToNexus(scope);

    const requestBody = {
      worker_id: delegateeId,
      worker_name: delegateeId,
      namespace_mode: mapNamespaceMode(namespaceMode),
      ttl_seconds: ttlSeconds,
      intent: "",
      can_sub_delegate: canSubDelegate && maxChainDepth > 0,
      ...(adjustments.add_grants.length > 0 ? { add_grants: adjustments.add_grants } : {}),
      ...(adjustments.remove_grants.length > 0 ? { remove_grants: adjustments.remove_grants } : {}),
      ...(adjustments.readonly_paths.length > 0
        ? { readonly_paths: adjustments.readonly_paths }
        : {}),
      ...(scope.resources !== undefined && scope.resources.length > 0
        ? { scope: { resource_patterns: scope.resources, max_depth: maxChainDepth } }
        : {}),
    };

    // Internal retry on transient/retryable failures. The same idempotency key
    // is reused for every attempt so Nexus deduplicates a partial-success
    // (delegation created server-side, response lost in transit) onto a single
    // delegation rather than creating duplicate active grants.
    // NOTE: this only collapses retries WITHIN one grant() call. If the host
    // retries the entire spawn, a fresh child AgentId produces a new idempotency
    // key — caller-supplied stable spawn ids are tracked as a follow-up.
    let result = await api.createDelegation(requestBody, { idempotencyKey });
    let attempts = 1;
    while (!result.ok && result.error.retryable === true && attempts < GRANT_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, GRANT_RETRY_DELAY_MS * attempts).unref?.(),
      );
      result = await api.createDelegation(requestBody, { idempotencyKey });
      attempts++;
    }

    if (!result.ok) {
      throw new Error(`Nexus delegation grant failed: ${result.error.message}`);
    }

    // Belt-and-suspenders: also wait for any drain enqueued during our POST
    // before installing. If a concurrent revoke fired during createDelegation
    // and queued an id that ended up matching the one we just minted (a
    // narrow window when callers re-issue revokes for ids they previously
    // saw), this barrier ensures the drain's grantStore.delete cannot land
    // after our install. Cheap when no new drain ran (already-resolved).
    await drainInProgress;

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
    // Clear any prior tombstone for this id, drop the stale verify cache
    // entry, AND remove any matching `pendingRevocations` queue entry.
    //
    // The queue removal is the load-bearing fix: with deterministic
    // idempotency or Nexus replay semantics, a `grant()` can return the same
    // delegation_id as one that previously failed to revoke. Without dropping
    // the queue entry, the next opportunistic `drainQueue()` would call
    // `revokeDelegation` on the freshly-issued grant — silently killing a
    // valid child credential. The current grant supersedes the stale revoke
    // intent: the caller can call `revoke()` again if they want this grant
    // gone.
    revokedTombstones.delete(g.id);
    verifyCache?.invalidate(g.id);
    pendingRevocations = pendingRevocations.filter((entry) => entry.id !== g.id);
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
      // Fail closed locally even when the remote DELETE failed: the caller
      // explicitly requested revocation, so any verify() against this grant
      // must immediately deny. We delete from `grantStore`, invalidate the
      // verify cache, AND record a tombstone so verify() returns "revoked"
      // even if a fresh cache entry is set later by an in-flight verifyFromNexus
      // refresh that races the revoke. The retry queue keeps reconciling in
      // the background.
      const childId = storedGrant?.delegateeId ?? UNKNOWN_AGENT_ID;
      enqueueRevocation(id, childId);
      grantStore.delete(id);
      verifyCache?.invalidate(id);
      addTombstone(id);
      console.error(
        `[nexus-delegation] revoke failed and queued for retry: ` +
          `delegationId="${id}", childId="${childId}", error: ${result.error.message}`,
      );
      throw new Error(
        `Nexus delegation revoke failed (queued for retry): id=${id}, error: ${result.error.message}`,
      );
    }

    grantStore.delete(id);
    verifyCache?.invalidate(id);
    addTombstone(id);
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

    // Validate every chain entry, not just the leaf. Nexus does not always
    // synchronously cascade ancestor revocations to the leaf status, so a leaf
    // marked "active" can still belong to a chain whose parent was already
    // revoked or expired. Deny on any non-active ancestor.
    for (const entry of chain.chain) {
      const denyReason = chainStatusToDenyReason(entry.status);
      if (denyReason !== undefined) {
        const r: DelegationVerifyResult = { ok: false, reason: denyReason };
        verifyCache?.set(id, toolId, r);
        return r;
      }
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
    // Tombstone fast path: any grant whose revoke() was observed (succeeded
    // OR failed-and-enqueued) MUST deny here, even if a positive verify cache
    // entry would otherwise authorize. This closes the race between an
    // in-flight verify refresh and a concurrent revoke.
    if (hasTombstone(id)) {
      return { ok: false, reason: "revoked" };
    }

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

    // TTL cache. Fresh hit → serve immediately.
    // Stale + negative (already-denied) → serve stale + background refresh; the
    // worst case is one extra denial that may have flipped to allow, which is
    // safe to delay.
    // Stale + positive (allowed) → MUST revalidate synchronously. Serving a
    // stale `ok: true` would authorize a tool call after the underlying grant
    // could have been revoked or expired in Nexus, which silently widens the
    // capability boundary this backend is supposed to enforce.
    if (verifyCache !== undefined) {
      const cached = verifyCache.get(id, toolId);
      if (cached !== undefined) {
        if (!verifyCache.isStale(id, toolId)) return cached;
        if (!cached.ok) {
          void verifyFromNexus(id, toolId);
          return cached;
        }
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

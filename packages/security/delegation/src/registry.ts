/**
 * In-memory revocation registry and grant index for cascade lookups.
 *
 * The registry stores revoked delegation IDs with optional TTL cleanup.
 * The grant index maintains parent→children mappings for efficient cascading.
 */

import type { DelegationGrant, DelegationId, RevocationRegistry } from "@koi/core";

// ---------------------------------------------------------------------------
// In-memory revocation registry
// ---------------------------------------------------------------------------

/** Concrete return type for the in-memory registry with convenience methods. */
export interface InMemoryRegistry extends RevocationRegistry {
  /** Returns all currently revoked IDs (convenience — not part of the L0 interface). */
  readonly revokedIds: () => ReadonlySet<DelegationId>;
  /** Stops the periodic cleanup interval. */
  readonly dispose: () => void;
}

/**
 * Creates an in-memory revocation registry.
 *
 * Revocations are permanent — revoked IDs are stored in a Set that is never
 * evicted. Previously, revocations and grants shared a single Map with LRU
 * eviction, which allowed previously-revoked IDs to silently become valid
 * again when the map exceeded `maxEntries`.
 *
 * `cleanupIntervalMs` is retained for API compatibility but is currently
 * a no-op since revocations are never evicted.
 */
export function createInMemoryRegistry(config?: {
  readonly cleanupIntervalMs?: number;
}): InMemoryRegistry {
  // Revoked IDs are stored in a Set that never evicts — revocations are permanent.
  const revoked = new Set<DelegationId>();

  // Lazy timer — retained for dispose() API compatibility
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanupIntervalMs = config?.cleanupIntervalMs ?? 60_000;

  function ensureTimer(): void {
    if (timer === undefined) {
      timer = setInterval(() => {
        // no-op — revocations are never evicted
      }, cleanupIntervalMs);
    }
  }

  function isRevoked(id: DelegationId): boolean {
    return revoked.has(id);
  }

  function revoke(id: DelegationId, _cascade: boolean): void {
    ensureTimer();
    revoked.add(id);
  }

  function revokedIds(): ReadonlySet<DelegationId> {
    return new Set(revoked);
  }

  function dispose(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { isRevoked, revoke, revokedIds, dispose };
}

// ---------------------------------------------------------------------------
// Grant index (parent → children mapping)
// ---------------------------------------------------------------------------

export interface GrantIndex {
  readonly addGrant: (grant: DelegationGrant) => void;
  readonly removeGrant: (grant: DelegationGrant) => void;
  readonly childrenOf: (id: DelegationId) => readonly DelegationId[];
}

/** Creates a parent→children index for efficient cascade lookups. */
export function createGrantIndex(): GrantIndex {
  const parentToChildren = new Map<DelegationId, DelegationId[]>();

  function addGrant(grant: DelegationGrant): void {
    if (grant.parentId === undefined) return;

    const existing = parentToChildren.get(grant.parentId);
    if (existing !== undefined) {
      parentToChildren.set(grant.parentId, [...existing, grant.id]);
    } else {
      parentToChildren.set(grant.parentId, [grant.id]);
    }
  }

  function removeGrant(grant: DelegationGrant): void {
    if (grant.parentId === undefined) return;

    const children = parentToChildren.get(grant.parentId);
    if (children === undefined) return;

    const filtered = children.filter((id) => id !== grant.id);
    if (filtered.length === 0) {
      parentToChildren.delete(grant.parentId);
    } else {
      parentToChildren.set(grant.parentId, filtered);
    }
  }

  function childrenOf(id: DelegationId): readonly DelegationId[] {
    return parentToChildren.get(id) ?? [];
  }

  return { addGrant, removeGrant, childrenOf };
}

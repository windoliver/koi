/**
 * In-memory revocation registry and grant index for cascade lookups.
 *
 * The registry stores revoked delegation IDs permanently (no eviction).
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
 */
export function createInMemoryRegistry(_config?: {
  /** @deprecated No longer used — revocations are permanent and never evicted. */
  readonly cleanupIntervalMs?: number;
}): InMemoryRegistry {
  // Revoked IDs are stored in a Set that never evicts — revocations are permanent.
  const revoked = new Set<DelegationId>();

  function isRevoked(id: DelegationId): boolean {
    return revoked.has(id);
  }

  function revoke(id: DelegationId, _cascade: boolean): void {
    revoked.add(id);
  }

  function revokedIds(): ReadonlySet<DelegationId> {
    return new Set(revoked);
  }

  function dispose(): void {
    // No-op — retained for API compatibility. Previously stopped a cleanup
    // interval that is no longer needed since revocations are permanent.
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

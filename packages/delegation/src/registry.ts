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

interface RegistryEntry {
  readonly revokedAt: number;
}

/** Concrete return type for the in-memory registry with convenience methods. */
export interface InMemoryRegistry extends RevocationRegistry {
  /** Returns all currently revoked IDs (convenience — not part of the L0 interface). */
  readonly revokedIds: () => ReadonlySet<DelegationId>;
  /** Stops the periodic cleanup interval. */
  readonly dispose: () => void;
}

/**
 * Creates an in-memory revocation registry with configurable max entries
 * and periodic cleanup. `maxEntries` and `cleanupIntervalMs` are local
 * configuration for this implementation, not part of L0 DelegationConfig.
 */
export function createInMemoryRegistry(config?: {
  readonly maxEntries?: number;
  readonly cleanupIntervalMs?: number;
}): InMemoryRegistry {
  const maxEntries = config?.maxEntries ?? 10_000;
  const cleanupIntervalMs = config?.cleanupIntervalMs ?? 60_000;

  const entries = new Map<DelegationId, RegistryEntry>();

  // Periodic cleanup — remove oldest entries when over capacity
  const timer = setInterval(() => {
    evictIfOverCapacity(entries, maxEntries);
  }, cleanupIntervalMs);

  function isRevoked(id: DelegationId): boolean {
    return entries.has(id);
  }

  function revoke(id: DelegationId, _cascade: boolean): void {
    entries.set(id, { revokedAt: Date.now() });
    evictIfOverCapacity(entries, maxEntries);
  }

  function revokedIds(): ReadonlySet<DelegationId> {
    return new Set(entries.keys());
  }

  function dispose(): void {
    clearInterval(timer);
  }

  return { isRevoked, revoke, revokedIds, dispose };
}

/** Evicts the oldest entries when the map exceeds maxEntries. */
function evictIfOverCapacity(entries: Map<DelegationId, RegistryEntry>, maxEntries: number): void {
  if (entries.size <= maxEntries) return;

  // Map iteration order is insertion order — delete from the front
  const toRemove = entries.size - maxEntries;
  let removed = 0;
  for (const key of entries.keys()) {
    if (removed >= toRemove) break;
    entries.delete(key);
    removed++;
  }
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
      existing.push(grant.id);
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

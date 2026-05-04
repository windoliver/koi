/**
 * Module-level lock registry for `createSnapshotStoreNexus`.
 *
 * WHY: `chainLocks` and `canonicalMutex` must be shared across all store
 * instances that point at the same Nexus backend. Without this, two
 * `createSnapshotStoreNexus(...)` calls with DIFFERENT transport objects
 * (e.g. decorator wrappers, separate HTTP clients to the same URL) produce
 * independent lock maps — a concurrent put on the same chainId from two
 * instances can interleave and corrupt meta.
 *
 * KEY DESIGN:
 *   - Key: caller-supplied `lockScope` string (module-level Map, never GC'd —
 *     same trade-off as `playbook-locks.ts`).
 *   - Two stores with the same `lockScope` string share one lock pool,
 *     regardless of how many transport objects are involved.
 *   - Default scope = `basePath` (or `"snapshots"` if neither is supplied),
 *     which is safe when each basePath maps to exactly one backend.
 *
 * ISOLATION: tests that call `createFakeNexusTransport()` per test must
 * also use distinct `lockScope` values (or distinct `basePath` values) to
 * get independent pools. The existing tests rely on unique chain IDs within
 * a shared pool, which is still correct.
 *
 * Reference design: `packages/lib/playbook-store-nexus/src/playbook-locks.ts`
 * uses a module-level Map for the same reason (single-process singleton).
 */

import type { ChainId } from "@koi/core";

/** Mutable box so `canonicalMutex` can be replaced inside `withCanonicalMutex`. */
export interface CanonicalMutexBox {
  current: Promise<void>;
}

interface LockPool {
  readonly chainLocks: Map<ChainId, Promise<void>>;
  readonly canonicalMutexBox: CanonicalMutexBox;
}

// Module-level singleton: keyed by lockScope string.
const registry = new Map<string, LockPool>();

function getPool(scope: string): LockPool {
  let pool = registry.get(scope);
  if (pool === undefined) {
    pool = {
      chainLocks: new Map<ChainId, Promise<void>>(),
      canonicalMutexBox: { current: Promise.resolve() },
    };
    registry.set(scope, pool);
  }
  return pool;
}

/**
 * Returns the chain-lock Map for the given lock scope.
 * All `createSnapshotStoreNexus` instances with the same `lockScope` share
 * this Map, so concurrent puts on the same chainId serialize correctly even
 * across wrapper-transport instances.
 */
export function getChainLockMap(scope: string): Map<ChainId, Promise<void>> {
  return getPool(scope).chainLocks;
}

/**
 * Returns the canonical-mutex box for the given lock scope.
 * Callers mutate `box.current` to replace the mutex promise.
 */
export function getCanonicalMutexBox(scope: string): CanonicalMutexBox {
  return getPool(scope).canonicalMutexBox;
}

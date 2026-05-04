/**
 * Module-level lock registry for `createSnapshotStoreNexus`.
 *
 * WHY: `chainLocks` and `canonicalMutex` must be shared across all store
 * instances that reference the same transport + basePath. Without this, two
 * `createSnapshotStoreNexus(...)` calls with the same transport produce
 * independent lock maps — a concurrent put on the same chainId from two
 * instances can interleave and corrupt meta.
 *
 * KEY DESIGN:
 *   - Outer key: `NexusTransport` instance (WeakMap → GC-friendly, no
 *     transport registration/cleanup required).
 *   - Inner key: `basePath` string (different base paths = different namespaces).
 *   - Value: `{ chainLocks, canonicalMutexBox }` shared by all instances
 *     with the same (transport, basePath) pair.
 *
 * ISOLATION: different `NexusTransport` instances get independent lock pools,
 * which preserves test isolation (each test calls `createFakeNexusTransport()`
 * producing a fresh instance).
 *
 * Reference design: `packages/lib/playbook-store-nexus/src/playbook-locks.ts`
 * uses a module-level Map for the same reason (single-process singleton).
 */

import type { ChainId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

/** Mutable box so `canonicalMutex` can be replaced inside `withCanonicalMutex`. */
export interface CanonicalMutexBox {
  current: Promise<void>;
}

interface LockPool {
  readonly chainLocks: Map<ChainId, Promise<void>>;
  readonly canonicalMutexBox: CanonicalMutexBox;
}

// WeakMap: entries are automatically collected when the transport is GC'd.
const registry = new WeakMap<NexusTransport, Map<string, LockPool>>();

function getPool(transport: NexusTransport, basePath: string): LockPool {
  let byPath = registry.get(transport);
  if (byPath === undefined) {
    byPath = new Map<string, LockPool>();
    registry.set(transport, byPath);
  }
  let pool = byPath.get(basePath);
  if (pool === undefined) {
    pool = {
      chainLocks: new Map<ChainId, Promise<void>>(),
      canonicalMutexBox: { current: Promise.resolve() },
    };
    byPath.set(basePath, pool);
  }
  return pool;
}

/**
 * Returns the chain-lock Map for the given (transport, basePath) pair.
 * All `createSnapshotStoreNexus` instances with the same transport + basePath
 * share this Map, so concurrent puts on the same chainId serialize correctly.
 */
export function getChainLockMap(
  transport: NexusTransport,
  basePath: string,
): Map<ChainId, Promise<void>> {
  return getPool(transport, basePath).chainLocks;
}

/**
 * Returns the canonical-mutex box for the given (transport, basePath) pair.
 * Callers mutate `box.current` to replace the mutex promise.
 */
export function getCanonicalMutexBox(
  transport: NexusTransport,
  basePath: string,
): CanonicalMutexBox {
  return getPool(transport, basePath).canonicalMutexBox;
}

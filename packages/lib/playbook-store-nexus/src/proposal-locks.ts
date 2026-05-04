/**
 * Module-level lock registry for proposal/evaluation id-level mutexes.
 *
 * WHY: `idLocks` in `createNexusPlaybookProposalStore` was per-factory-closure.
 * Two instances sharing the same transport + basePath produced independent lock
 * Maps — a concurrent `recordProposal` with the same id from two instances could
 * interleave, bypass the immutability check, and write conflicting content.
 *
 * KEY DESIGN:
 *   - Outer key: `NexusTransport` instance (WeakMap → GC-friendly).
 *   - Middle key: `basePath` string.
 *   - Inner key: lock key string (e.g. proposal id, eval id namespace).
 *   - Value: the current tail Promise<void> of the mutex chain.
 *
 * ISOLATION: different `NexusTransport` instances get independent lock pools,
 * preserving test isolation (each test creates a fresh transport).
 *
 * Reference design: `playbook-locks.ts` uses a module-level Map for the same
 * reason. This module extends that pattern to the per-id level.
 */

import type { NexusTransport } from "@koi/nexus-client";

// WeakMap outer key: transport instance. Automatically collected when transport is GC'd.
const registry = new WeakMap<NexusTransport, Map<string, Map<string, Promise<void>>>>();

function getLockMap(transport: NexusTransport, basePath: string): Map<string, Promise<void>> {
  let byPath = registry.get(transport);
  if (byPath === undefined) {
    byPath = new Map();
    registry.set(transport, byPath);
  }
  let lockMap = byPath.get(basePath);
  if (lockMap === undefined) {
    lockMap = new Map();
    byPath.set(basePath, lockMap);
  }
  return lockMap;
}

/**
 * Acquire a per-key mutex for the given (transport, basePath) pair and run `fn`.
 *
 * All `createNexusPlaybookProposalStore` instances with the same transport +
 * basePath share this lock registry, so concurrent operations on the same key
 * serialize correctly even across instances.
 */
export function withProposalLock<R>(
  transport: NexusTransport,
  basePath: string,
  key: string,
  fn: () => Promise<R>,
): Promise<R> {
  const lockMap = getLockMap(transport, basePath);
  const prev = lockMap.get(key) ?? Promise.resolve();
  // let is justified: release must be assigned inside the Promise constructor callback
  let release = (): void => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockMap.set(key, next);
  const run = async (): Promise<R> => {
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return run();
}

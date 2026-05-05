/**
 * Module-level lock registry for proposal/evaluation id-level mutexes.
 *
 * WHY: `idLocks` in `createNexusPlaybookProposalStore` was per-factory-closure.
 * Two instances sharing the same backend (even via DIFFERENT transport objects —
 * e.g. decorator wrappers) produced independent lock Maps — a concurrent
 * `recordProposal` with the same id from two instances could interleave, bypass
 * the immutability check, and write conflicting content.
 *
 * KEY DESIGN:
 *   - Outer key: caller-supplied `lockScope` string (module-level Map).
 *   - Inner key: lock key string (e.g. proposal id, eval id namespace).
 *   - Value: the current tail Promise<void> of the mutex chain.
 *   - Two stores with the same `lockScope` share one registry, regardless of
 *     how many transport objects are involved.
 *
 * Reference design: `playbook-locks.ts` uses a module-level Map for the same
 * reason. This module extends that pattern to the per-id level.
 */

// Module-level singleton: outer key = lockScope, inner key = per-id lock key.
const registry = new Map<string, Map<string, Promise<void>>>();

function getLockMap(scope: string): Map<string, Promise<void>> {
  let lockMap = registry.get(scope);
  if (lockMap === undefined) {
    lockMap = new Map();
    registry.set(scope, lockMap);
  }
  return lockMap;
}

/**
 * Acquire a per-key mutex for the given lock scope and run `fn`.
 *
 * All `createNexusPlaybookProposalStore` instances with the same `lockScope`
 * share this registry, so concurrent operations on the same key serialize
 * correctly even across wrapper-transport instances.
 */
export function withProposalLock<R>(scope: string, key: string, fn: () => Promise<R>): Promise<R> {
  const lockMap = getLockMap(scope);
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

/**
 * Singleton per-playbook mutex shared across structured.save and
 * recordProposal within a single Bun process.
 *
 * WHY: the baseVersion check in recordProposal is a read-then-write; if a
 * concurrent structured.save advances the head between the read and the write,
 * the stale-base check passes incorrectly. Wrapping both operations in the
 * same playbook lock serialises them in-process.
 *
 * LIMIT: this is a per-process lock. Cross-process atomicity still requires
 * Nexus-level CAS (tracking: #1469).
 *
 * KEY DESIGN:
 *   - Outer key: caller-supplied `lockScope` string (module-level Map).
 *   - Inner key: `playbookId`.
 *   - Two stores with the same `lockScope` share one lock domain, regardless
 *     of how many transport objects are involved. This prevents races between
 *     wrapper-transport store instances pointing at the same backend.
 */

// Module-level singleton: outer key = lockScope, inner key = playbookId.
const registry = new Map<string, Map<string, Promise<void>>>();

function getLockMap(scope: string): Map<string, Promise<void>> {
  let lockMap = registry.get(scope);
  if (lockMap === undefined) {
    lockMap = new Map();
    registry.set(scope, lockMap);
  }
  return lockMap;
}

export function withPlaybookLock<R>(
  scope: string,
  playbookId: string,
  fn: () => Promise<R>,
): Promise<R> {
  const playbookLocks = getLockMap(scope);
  const prev = playbookLocks.get(playbookId) ?? Promise.resolve();
  // let is justified: release must be assigned inside the Promise constructor callback
  let release = (): void => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  playbookLocks.set(playbookId, next);
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

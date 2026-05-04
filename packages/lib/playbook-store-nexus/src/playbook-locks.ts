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
 * Callers import withPlaybookLock(playbookId, fn). The module-level Map is the
 * singleton — one lock domain per Bun process, shared across all store instances
 * that import this module.
 */

const playbookLocks = new Map<string, Promise<void>>();

export function withPlaybookLock<R>(playbookId: string, fn: () => Promise<R>): Promise<R> {
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

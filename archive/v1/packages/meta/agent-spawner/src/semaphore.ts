/**
 * Async semaphore — limits concurrent delegations.
 */

/** Counting semaphore for async concurrency control. */
export interface Semaphore {
  /** Acquire a permit, waiting if none are available. */
  readonly acquire: () => Promise<void>;
  /** Release a permit, waking one waiter if any. */
  readonly release: () => void;
  /** Number of currently held permits. */
  readonly activeCount: () => number;
}

/**
 * Create a counting semaphore with the given maximum concurrency.
 */
export function createSemaphore(max: number): Semaphore {
  // let: mutable counter and waiters queue
  let active = 0;
  const waiters: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      if (active < max) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(() => {
          active++;
          resolve();
        });
      });
    },

    release(): void {
      active--;
      const next = waiters.shift();
      if (next !== undefined) {
        next();
      }
    },

    activeCount(): number {
      return active;
    },
  };
}

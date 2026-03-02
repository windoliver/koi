/**
 * Simple counting semaphore for concurrency limiting.
 *
 * L2-local implementation — cannot import from @koi/engine (L1).
 * Simpler than the L1 version: no timeout support, just FIFO ordering.
 */

export interface Semaphore {
  /** Run an async function with a semaphore slot. Waits if at capacity. */
  readonly run: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Creates a counting semaphore that limits concurrent execution.
 *
 * @param maxConcurrency - Maximum number of concurrent slots.
 */
export function createSemaphore(maxConcurrency: number): Semaphore {
  if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a positive integer, got ${String(maxConcurrency)}`);
  }

  // let: mutable counter for active slots
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(resolve);
    });
  }

  function release(): void {
    const next = queue.shift();
    if (next !== undefined) {
      // Transfer slot directly to next waiter
      next();
    } else {
      active--;
    }
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run };
}

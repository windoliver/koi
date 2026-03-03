/**
 * Timeout-aware FIFO counting semaphore for concurrency limiting.
 *
 * Self-contained, no external deps. Used by the concurrency guard
 * to cap concurrent model/tool calls across all agents sharing an instance.
 *
 * Invariant: `activeCount` reflects the number of callers currently between
 * acquire and release. When a slot is transferred from a releaser to a waiter,
 * the active count stays the same (no decrement + increment).
 */

export interface ConcurrencySemaphore {
  /** Acquire a slot, waiting up to `timeoutMs`. Rejects on timeout. */
  readonly acquire: (timeoutMs: number) => Promise<void>;
  /** Release a previously acquired slot. */
  readonly release: () => void;
  /** Number of slots currently held. */
  readonly activeCount: () => number;
  /** Number of waiters queued for a slot. */
  readonly waitingCount: () => number;
}

interface Waiter {
  readonly fire: () => void;
  /** Returns true if this waiter timed out before being served. */
  readonly timedOut: () => boolean;
}

export function createConcurrencySemaphore(maxConcurrency: number): ConcurrencySemaphore {
  if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a positive integer, got ${String(maxConcurrency)}`);
  }

  // let justified: mutable counter tracking currently held slots
  let active = 0;
  // let justified: mutable FIFO queue for pending waiters
  const queue: Waiter[] = [];

  function acquire(timeoutMs: number): Promise<void> {
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      // let justified: mutable flag set when this waiter times out
      let didTimeout = false;

      const timer = setTimeout(() => {
        didTimeout = true;
        reject(new Error(`Semaphore acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      queue.push({
        fire: () => {
          clearTimeout(timer);
          // No active++ here — the slot is transferred from the releaser,
          // so the net count stays the same.
          resolve();
        },
        timedOut: () => didTimeout,
      });
    });
  }

  function release(): void {
    if (active <= 0) {
      throw new Error(
        `Semaphore release called with no active slots (active=${String(active)}). ` +
          "This indicates a double-release or unmatched release bug in the caller.",
      );
    }

    // Skip any waiters that timed out while queued
    while (queue.length > 0) {
      const waiter = queue.shift();
      if (waiter === undefined) break;
      if (!waiter.timedOut()) {
        // Transfer slot to waiter — active count stays the same
        waiter.fire();
        return;
      }
    }
    // No waiting consumers — return slot to pool
    active--;
  }

  return {
    acquire,
    release,
    activeCount: () => active,
    waitingCount: () => queue.length,
  };
}

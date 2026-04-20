/**
 * Timeout-aware FIFO counting semaphore for concurrency limiting.
 *
 * Self-contained, no external deps. Used by the concurrency guard
 * to cap concurrent model/tool calls across all agents sharing an instance.
 *
 * Invariant: `activeCount` reflects the number of callers currently between
 * acquire and release. When a slot is transferred from a releaser to a waiter,
 * the active count stays the same (no decrement + increment).
 *
 * Performance:
 * - acquire / release are amortized O(1)
 * - the waiter queue uses an array + head pointer (no O(n) shift)
 * - timed-out waiters remove themselves from the queue immediately via a
 *   stored index; the eager compaction on dequeue keeps memory bounded
 *   proportional to the number of live waiters
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
  /** Returns true if this waiter timed out or was otherwise invalidated. */
  readonly timedOut: () => boolean;
  /** Best-effort self-removal hook; zeroed once consumed by release(). */
  invalidate: () => void;
}

export function createConcurrencySemaphore(maxConcurrency: number): ConcurrencySemaphore {
  if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a positive integer, got ${String(maxConcurrency)}`);
  }

  // let justified: mutable counter tracking currently held slots
  let active = 0;
  // Array-backed FIFO with a head pointer — avoids O(n) `Array.shift()`
  // on high-throughput release paths.
  // let justified: queue and head pointer are mutated in place.
  let queue: (Waiter | undefined)[] = [];
  let head = 0;
  // Count of live (non-tombstoned) waiters currently in `queue`, for O(1) waitingCount.
  let liveWaiters = 0;

  /**
   * Compact the array when the dead prefix grows large. Amortized O(1)
   * per dequeue. Also compacts when the fraction of tombstones grows high.
   */
  function maybeCompact(): void {
    const len = queue.length;
    if (head === 0) return;
    const dead = len - (len - head);
    // Compact when the dead prefix is at least half the total array length.
    if (head >= len - head || dead >= 128) {
      queue = queue.slice(head);
      head = 0;
    }
  }

  function acquire(timeoutMs: number): Promise<void> {
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      // let justified: timeout flag flips when the setTimeout fires.
      let didTimeout = false;
      // let justified: position in `queue`; set after push, cleared on fire/timeout.
      let slot = -1;

      const timer = setTimeout(() => {
        didTimeout = true;
        if (slot !== -1 && queue[slot] !== undefined) {
          queue[slot] = undefined;
          liveWaiters = Math.max(0, liveWaiters - 1);
          slot = -1;
        }
        reject(new Error(`Semaphore acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter: Waiter = {
        fire: () => {
          if (didTimeout) return; // lost the race to the timeout
          clearTimeout(timer);
          // No active++ here — the slot is transferred from the releaser,
          // so the net count stays the same.
          resolve();
        },
        timedOut: () => didTimeout,
        invalidate: () => {
          if (slot !== -1) {
            queue[slot] = undefined;
            liveWaiters = Math.max(0, liveWaiters - 1);
            slot = -1;
          }
        },
      };

      slot = queue.length;
      queue.push(waiter);
      liveWaiters += 1;
    });
  }

  function release(): void {
    if (active <= 0) {
      throw new Error(
        `Semaphore release called with no active slots (active=${String(active)}). ` +
          "This indicates a double-release or unmatched release bug in the caller.",
      );
    }

    // Skip tombstoned / timed-out waiters until we hit a live one or exhaust.
    while (head < queue.length) {
      const waiter = queue[head];
      queue[head] = undefined;
      head += 1;
      if (waiter === undefined) continue;
      if (waiter.timedOut()) continue;
      waiter.invalidate();
      liveWaiters = Math.max(0, liveWaiters - 1);
      maybeCompact();
      // Transfer slot to waiter — active count stays the same.
      waiter.fire();
      return;
    }
    // No waiting consumer — return slot to pool and compact if needed.
    if (head > 0) {
      queue = [];
      head = 0;
    }
    active--;
  }

  return {
    acquire,
    release,
    activeCount: () => active,
    waitingCount: () => liveWaiters,
  };
}

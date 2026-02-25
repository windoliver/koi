/**
 * FIFO counting semaphore for concurrency control.
 *
 * Limits concurrent task spawns. Waiters are served in FIFO order.
 */

import type { Semaphore } from "./types.js";

/**
 * Creates a FIFO counting semaphore.
 *
 * When `acquire()` is called and active count < maxConcurrency,
 * the promise resolves immediately. Otherwise it enqueues a
 * resolver and waits until a `release()` call frees a slot.
 */
export function createSemaphore(maxConcurrency: number): Semaphore {
  // let justified: mutable counter + queue for semaphore state
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      if (active < maxConcurrency) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    },

    release(): void {
      const next = queue.shift();
      if (next !== undefined) {
        next();
      } else {
        active -= 1;
      }
    },

    activeCount(): number {
      return active;
    },
  };
}

/**
 * InMemorySpawnLedger — in-memory implementation of the SpawnLedger interface.
 *
 * Tracks active agent processes via a simple counter.
 * Scoped to a single Node (process); for multi-Node tracking, provide a
 * distributed SpawnLedger implementation via CreateKoiOptions.spawnLedger.
 */

import type { SpawnLedger } from "@koi/core";

/**
 * Create an in-memory SpawnLedger with the given capacity.
 *
 * The root agent creates this ledger and shares it with all children
 * in the spawn tree. All acquire/release calls are synchronous.
 */
export function createInMemorySpawnLedger(maxTotal: number): SpawnLedger {
  if (maxTotal < 0 || !Number.isInteger(maxTotal)) {
    throw new Error(`SpawnLedger capacity must be a non-negative integer, got: ${maxTotal}`);
  }

  // let justified: mutable counter for active slots, scoped to ledger lifetime
  let active = 0;
  // let justified: mutable queue of waiters for backpressure support
  const waiters: Array<(acquired: boolean) => void> = [];

  return {
    acquire: (): boolean => {
      if (active >= maxTotal) {
        return false;
      }
      active++;
      return true;
    },

    release: (): void => {
      if (active > 0) {
        active--;
      }
      // Wake the first waiter if a slot freed up and we're under capacity
      if (waiters.length > 0 && active < maxTotal) {
        const waiter = waiters.shift();
        if (waiter) {
          active++;
          waiter(true);
        }
      }
    },

    activeCount: (): number => active,

    capacity: (): number => maxTotal,

    acquireOrWait: (signal: AbortSignal): Promise<boolean> => {
      // Check cancellation BEFORE claiming capacity — an already-aborted signal must
      // never acquire a ledger slot, even if one is available. Claiming then rolling
      // back is racy; refusing upfront is atomic and correct.
      if (signal.aborted) {
        return Promise.resolve(false);
      }
      // Fast path: slot available and not cancelled
      if (active < maxTotal) {
        active++;
        return Promise.resolve(true);
      }
      // Enqueue and wait for release() to wake us
      return new Promise<boolean>((resolve) => {
        const onAbort = (): void => {
          const idx = waiters.indexOf(waiterFn);
          if (idx !== -1) {
            waiters.splice(idx, 1);
          }
          resolve(false);
        };
        const waiterFn = (acquired: boolean): void => {
          signal.removeEventListener("abort", onAbort);
          resolve(acquired);
        };
        waiters.push(waiterFn);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

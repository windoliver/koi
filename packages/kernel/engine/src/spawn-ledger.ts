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
    },

    activeCount: (): number => active,

    capacity: (): number => maxTotal,
  };
}

/**
 * Temporal-backed SpawnLedger — implements L0 SpawnLedger contract.
 *
 * In-memory slot counter within the Activity context. The active count
 * is included in workflow state refs and survives Continue-As-New via
 * the lightweight state payload.
 */

import type { SpawnLedger } from "@koi/core";

export interface TemporalSpawnLedgerConfig {
  readonly maxCapacity: number;
}

export const DEFAULT_SPAWN_LEDGER_CONFIG: TemporalSpawnLedgerConfig = Object.freeze({
  maxCapacity: 10,
});

export interface SpawnLedgerSnapshot {
  readonly activeCount: number;
  readonly capacity: number;
}

export function createTemporalSpawnLedger(
  config: TemporalSpawnLedgerConfig = DEFAULT_SPAWN_LEDGER_CONFIG,
  initialActiveCount = 0,
): SpawnLedger & { readonly snapshot: () => SpawnLedgerSnapshot } {
  let active = initialActiveCount;

  return {
    acquire(): boolean {
      if (active >= config.maxCapacity) return false;
      active++;
      return true;
    },

    release(): void {
      if (active > 0) active--;
    },

    activeCount(): number {
      return active;
    },

    capacity(): number {
      return config.maxCapacity;
    },

    snapshot(): SpawnLedgerSnapshot {
      return { activeCount: active, capacity: config.maxCapacity };
    },
  };
}

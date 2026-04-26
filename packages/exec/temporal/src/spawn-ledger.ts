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
  if (!Number.isFinite(config.maxCapacity) || config.maxCapacity <= 0) {
    throw new Error(`maxCapacity must be a positive finite number, got ${config.maxCapacity}`);
  }
  // Clamp restored count to [0, maxCapacity] to guard against stale/corrupted state.
  let active = Math.min(Math.max(0, initialActiveCount), config.maxCapacity);

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

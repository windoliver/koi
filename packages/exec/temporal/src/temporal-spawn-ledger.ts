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
  if (!Number.isInteger(config.maxCapacity) || config.maxCapacity < 0) {
    throw new Error(
      `createTemporalSpawnLedger: maxCapacity must be a non-negative integer, got ${config.maxCapacity}`,
    );
  }
  if (
    !Number.isInteger(initialActiveCount) ||
    initialActiveCount < 0 ||
    initialActiveCount > config.maxCapacity
  ) {
    throw new Error(
      `createTemporalSpawnLedger: initialActiveCount must be an integer in [0, maxCapacity=${config.maxCapacity}], got ${initialActiveCount}`,
    );
  }
  let active = initialActiveCount;

  return {
    acquire(): boolean {
      if (active >= config.maxCapacity) return false;
      active++;
      return true;
    },

    release(): void {
      if (active > 0) {
        active--;
      }
    },

    activeCount(): number {
      return active;
    },

    capacity(): number {
      return config.maxCapacity;
    },

    snapshot(): SpawnLedgerSnapshot {
      return {
        activeCount: active,
        capacity: config.maxCapacity,
      };
    },
  };
}

/**
 * Temporal-backed SpawnLedger — implements L0 SpawnLedger contract.
 *
 * Decision 4A: Alternative backend (existing packages unchanged).
 * Decision 12A: Must pass L0 contract test suite.
 *
 * Tracks spawn slots as in-memory counters within the Activity context.
 * The count is included in the workflow state refs and survives
 * Continue-As-New via the lightweight state payload.
 */

import type { SpawnLedger } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TemporalSpawnLedgerConfig {
  /** Maximum number of concurrent child workflows. Default: 10. */
  readonly maxCapacity: number;
}

export const DEFAULT_SPAWN_LEDGER_CONFIG: TemporalSpawnLedgerConfig = Object.freeze({
  maxCapacity: 10,
});

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a Temporal-backed SpawnLedger.
 *
 * This implementation is in-memory (synchronous acquire/release) —
 * the durable aspect comes from the Temporal workflow state that
 * carries the active count across Continue-As-New boundaries.
 *
 * For distributed (multi-Node) spawn accounting, use the Nexus-backed
 * SpawnLedger from @koi/ipc-nexus instead.
 *
 * @param config - Spawn ledger configuration
 * @param initialActiveCount - Restored active count from workflow state (for CAN recovery)
 */
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

    /** Snapshot for inclusion in workflow state refs. */
    snapshot(): SpawnLedgerSnapshot {
      return {
        activeCount: active,
        capacity: config.maxCapacity,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot type (for workflow state serialization)
// ---------------------------------------------------------------------------

export interface SpawnLedgerSnapshot {
  readonly activeCount: number;
  readonly capacity: number;
}

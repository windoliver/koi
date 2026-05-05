/**
 * Federation types — sequence-cursor sync model (Phase 3 baseline).
 *
 * Vector clocks, LWW conflict resolution, snapshot truncation, and clock
 * pruning are intentionally absent — deferred to #1410 (Phase 4e).
 */

import type { ZoneId } from "@koi/core";

// ---------------------------------------------------------------------------
// Sync cursor
// ---------------------------------------------------------------------------

/** Tracks sync progress for a single remote zone. */
export interface SyncCursor {
  readonly zoneId: ZoneId;
  /** Highest event sequence number processed from this remote. */
  readonly lastSequence: number;
  /** Unix timestamp ms of the last successful sync (0 if never synced). */
  readonly lastSyncAt: number;
}

// ---------------------------------------------------------------------------
// Federation sync event
// ---------------------------------------------------------------------------

/** Envelope for events replicated across zones. */
export interface FederationSyncEvent {
  readonly kind: string;
  readonly originZoneId: ZoneId;
  /** Monotonic per-origin-zone sequence number. */
  readonly sequence: number;
  readonly data: Readonly<Record<string, unknown>>;
  readonly emittedAt: number;
}

// ---------------------------------------------------------------------------
// Federation config
// ---------------------------------------------------------------------------

/** Configuration for the federation sync engine. */
export interface FederationConfig {
  readonly localZoneId: ZoneId;
  readonly remoteZones: readonly ZoneId[];
  /** Fixed poll interval in milliseconds. */
  readonly pollIntervalMs: number;
  /** Mark a remote zone offline locally after N consecutive fetch failures. */
  readonly offlineAfterFailures: number;
}

/** Sensible defaults for federation config (Phase 3 baseline). */
export const DEFAULT_FEDERATION_CONFIG: Readonly<{
  readonly pollIntervalMs: 5_000;
  readonly offlineAfterFailures: 3;
}> = {
  pollIntervalMs: 5_000,
  offlineAfterFailures: 3,
} as const satisfies Partial<FederationConfig>;

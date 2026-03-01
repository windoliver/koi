/**
 * Federation types — vector clocks, sync cursors, sync events, and config.
 */

import type { ZoneId } from "@koi/core";

// ---------------------------------------------------------------------------
// Vector clock
// ---------------------------------------------------------------------------

/** Component-wise logical clock. Keys are zone IDs, values are sequence numbers. */
export type VectorClock = Readonly<Record<string, number>>;

// ---------------------------------------------------------------------------
// Clock comparison result
// ---------------------------------------------------------------------------

/** Result of comparing two vector clocks. */
export type ClockOrder = "before" | "after" | "concurrent" | "equal";

// ---------------------------------------------------------------------------
// Sync cursor
// ---------------------------------------------------------------------------

/** Tracks sync progress for a single remote zone. */
export interface SyncCursor {
  readonly zoneId: ZoneId;
  readonly vectorClock: VectorClock;
  readonly lastSequence: number;
  readonly lastSyncAt: number;
}

// ---------------------------------------------------------------------------
// Federation sync event
// ---------------------------------------------------------------------------

/** Envelope for events replicated across zones. */
export interface FederationSyncEvent {
  readonly kind: string;
  readonly originZoneId: ZoneId;
  readonly sequence: number;
  readonly vectorClock: VectorClock;
  readonly data: Readonly<Record<string, unknown>>;
  readonly emittedAt: number;
}

// ---------------------------------------------------------------------------
// Conflict resolution strategy
// ---------------------------------------------------------------------------

/** Strategy for resolving concurrent updates to the same resource. */
export type ConflictResolution = "lww";

// ---------------------------------------------------------------------------
// Federation config
// ---------------------------------------------------------------------------

/** Configuration for the federation sync engine. */
export interface FederationConfig {
  readonly localZoneId: ZoneId;
  readonly remoteZones: readonly ZoneId[];
  readonly pollIntervalMs: number;
  readonly minPollIntervalMs: number;
  readonly maxPollIntervalMs: number;
  readonly snapshotThreshold: number;
  readonly clockPruneAfterMs: number;
  readonly conflictResolution: ConflictResolution;
}

/** Sensible defaults for federation config. */
export const DEFAULT_FEDERATION_CONFIG: Readonly<{
  readonly pollIntervalMs: 5_000;
  readonly minPollIntervalMs: 1_000;
  readonly maxPollIntervalMs: 30_000;
  readonly snapshotThreshold: 1_000;
  readonly clockPruneAfterMs: 86_400_000;
  readonly conflictResolution: "lww";
}> = {
  pollIntervalMs: 5_000,
  minPollIntervalMs: 1_000,
  maxPollIntervalMs: 30_000,
  snapshotThreshold: 1_000,
  clockPruneAfterMs: 86_400_000, // 24h
  conflictResolution: "lww",
} as const satisfies Partial<FederationConfig>;

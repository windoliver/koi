/**
 * Federation types — sequence-cursor sync model with vector-clock metadata.
 */

import type { ZoneId } from "@koi/core";

// ---------------------------------------------------------------------------
// Vector clock
// ---------------------------------------------------------------------------

/** Component-wise logical clock. Keys are zone IDs, values are sequence numbers. */
export type VectorClock = Readonly<Record<string, number>>;

/** Result of comparing two vector clocks. */
export type ClockOrder = "before" | "after" | "concurrent" | "equal";

/** Strategy for resolving concurrent writes to the same shared resource. */
export type ConflictResolutionStrategy = "lww" | "merge" | "manual";

// ---------------------------------------------------------------------------
// Sync cursor
// ---------------------------------------------------------------------------

/** Tracks sync progress for a single remote zone. */
export interface SyncCursor {
  readonly zoneId: ZoneId;
  /** Component-wise causal position for events processed from this remote. */
  readonly vectorClock?: VectorClock;
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
  /** Optional causal clock used for cross-zone conflict detection. */
  readonly vectorClock?: VectorClock;
  readonly data: Readonly<Record<string, unknown>>;
  readonly emittedAt: number;
}

// ---------------------------------------------------------------------------
// Conflict reporting
// ---------------------------------------------------------------------------

/** A concurrent write conflict between two events targeting one resource. */
export interface ConflictReport {
  readonly resourceKey: string;
  readonly order: "concurrent";
  readonly local: FederationSyncEvent;
  readonly remote: FederationSyncEvent;
  readonly strategy: ConflictResolutionStrategy;
}

/** Outcome selected by a conflict-resolution strategy. */
export type ConflictResolutionResult =
  | {
      readonly kind: "resolved";
      readonly strategy: Exclude<ConflictResolutionStrategy, "manual">;
      readonly event: FederationSyncEvent;
    }
  | {
      readonly kind: "manual";
      readonly strategy: "manual";
      readonly report: ConflictReport;
    };

/** Conflict report enriched with the selected resolution outcome. */
export interface ReportedConflict extends ConflictReport {
  readonly resolution: ConflictResolutionResult;
}

// ---------------------------------------------------------------------------
// Wire-protocol version
// ---------------------------------------------------------------------------

/**
 * Federation wire-protocol version. Increment on any breaking change to
 * the on-the-wire contract for `sync_fetch_delta` / `sync_publish` /
 * `zone_execute` / `zone_cancel`.
 *
 * **v1 contract (this Phase 3 baseline)**:
 * - `sync_fetch_delta` returns events whose sequences must form a
 *   contiguous prefix starting at `cursor.lastSequence + 1`. Gapped or
 *   non-contiguous batches are a protocol fault — the cursor will not
 *   advance and the local engine will count a failure.
 * - Duplicate sequence numbers within one batch are allowed only when
 *   the full event envelope matches byte-for-byte (kind, originZoneId,
 *   sequence, emittedAt, data). Mismatched payloads are a protocol fault.
 * - Every event's `originZoneId` must equal the zone being queried.
 * - `vectorClock`, when present, must be an object whose components are
 *   non-negative integer sequence values.
 * - `zone_cancel` must carry the full correlation tuple
 *   `{ callId, targetZoneId, originZoneId, toolId }`.
 */
export const FEDERATION_PROTOCOL_VERSION: 1 = 1;

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
  /** Resolution policy for concurrent writes to the same resource. */
  readonly conflictResolution: ConflictResolutionStrategy;
}

/** Sensible defaults for federation config (Phase 3 baseline). */
export const DEFAULT_FEDERATION_CONFIG: Readonly<{
  readonly pollIntervalMs: 5_000;
  readonly offlineAfterFailures: 3;
  readonly conflictResolution: "lww";
}> = {
  pollIntervalMs: 5_000,
  offlineAfterFailures: 3,
  conflictResolution: "lww",
} as const satisfies Partial<FederationConfig>;

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
 * - `zone_cancel` must carry the full correlation tuple
 *   `{ callId, targetZoneId, originZoneId, toolId }`.
 *
 * Vector clocks, LWW conflict resolution, adaptive polling, snapshot
 * truncation, and clock pruning are deferred to a future protocol
 * version (#1410, Phase 4e).
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
}

/** Sensible defaults for federation config (Phase 3 baseline). */
export const DEFAULT_FEDERATION_CONFIG: Readonly<{
  readonly pollIntervalMs: 5_000;
  readonly offlineAfterFailures: 3;
}> = {
  pollIntervalMs: 5_000,
  offlineAfterFailures: 3,
} as const satisfies Partial<FederationConfig>;

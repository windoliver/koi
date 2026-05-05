/**
 * Sync protocol — sequence-cursor federation sync primitives.
 *
 * SyncClient interface for fetching/publishing events, plus pure functions
 * for cursor advancement and deduplication. Phase 3 baseline: no vector
 * clocks, no LWW conflict resolution (#1410).
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { FederationSyncEvent, SyncCursor } from "./types.js";

// ---------------------------------------------------------------------------
// Sync client interface
// ---------------------------------------------------------------------------

/** Injectable client for fetching/publishing sync events. */
export interface SyncClient {
  /** Fetch new events from a remote zone since the given cursor. */
  readonly fetchDelta: (
    cursor: SyncCursor,
    maxEvents?: number,
  ) => Promise<Result<readonly FederationSyncEvent[], KoiError>>;

  /** Publish local events to the remote sync store. */
  readonly publishEvents: (
    events: readonly FederationSyncEvent[],
  ) => Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Nexus-backed sync client
// ---------------------------------------------------------------------------

/** Config for createNexusSyncClient. */
export interface NexusSyncClientConfig {
  readonly transport: NexusTransport;
}

/** Creates a SyncClient backed by Nexus JSON-RPC. */
export function createNexusSyncClient(config: NexusSyncClientConfig): SyncClient {
  const { transport } = config;

  return {
    fetchDelta: (cursor, maxEvents) => {
      return transport.call<readonly FederationSyncEvent[]>("federation.sync_fetch_delta", {
        zoneId: cursor.zoneId,
        lastSequence: cursor.lastSequence,
        maxEvents: maxEvents ?? 100,
      });
    },

    publishEvents: (events) => {
      return transport.call<void>("federation.sync_publish", { events });
    },
  };
}

// ---------------------------------------------------------------------------
// Cursor advancement (pure)
// ---------------------------------------------------------------------------

/**
 * Advance a sync cursor after processing a batch of events.
 * Updates lastSequence to the max sequence across the batch and refreshes
 * lastSyncAt.
 */
export function advanceCursor(
  cursor: SyncCursor,
  events: readonly FederationSyncEvent[],
  now: number = Date.now(),
): SyncCursor {
  if (events.length === 0) {
    return { zoneId: cursor.zoneId, lastSequence: cursor.lastSequence, lastSyncAt: now };
  }

  // let: accumulates max sequence across event batch
  let maxSequence = cursor.lastSequence;
  for (const event of events) {
    if (event.sequence > maxSequence) {
      maxSequence = event.sequence;
    }
  }

  return {
    zoneId: cursor.zoneId,
    lastSequence: maxSequence,
    lastSyncAt: now,
  };
}

// ---------------------------------------------------------------------------
// Deduplication (pure)
// ---------------------------------------------------------------------------

/**
 * Filter out events already seen according to the cursor.
 * Keeps only events with sequence > cursor.lastSequence.
 */
export function deduplicateEvents(
  events: readonly FederationSyncEvent[],
  cursor: SyncCursor,
): readonly FederationSyncEvent[] {
  return events.filter((e) => e.sequence > cursor.lastSequence);
}

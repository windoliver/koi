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
import { FEDERATION_PROTOCOL_VERSION } from "./types.js";

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
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        zoneId: cursor.zoneId,
        lastSequence: cursor.lastSequence,
        maxEvents: maxEvents ?? 100,
      });
    },

    publishEvents: (events) => {
      return transport.call<void>("federation.sync_publish", {
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        events,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Cursor advancement (pure)
// ---------------------------------------------------------------------------

/**
 * Advance a sync cursor after processing a batch of events.
 *
 * Advances `lastSequence` only through the highest contiguous prefix
 * starting at `cursor.lastSequence + 1`. If the batch is gapped or
 * out-of-order, the cursor stops at the last contiguous sequence — the
 * remaining events are NOT acknowledged and will be redelivered on the
 * next sync. This prevents permanent event loss when a remote returns
 * a non-contiguous batch (pagination, retry, partial replay).
 */
export function advanceCursor(
  cursor: SyncCursor,
  events: readonly FederationSyncEvent[],
  now: number = Date.now(),
): SyncCursor {
  if (events.length === 0) {
    return { zoneId: cursor.zoneId, lastSequence: cursor.lastSequence, lastSyncAt: now };
  }

  const seen = new Set<number>();
  for (const event of events) {
    if (event.sequence > cursor.lastSequence) {
      seen.add(event.sequence);
    }
  }

  // let: walks the contiguous prefix above the prior cursor
  let advanced = cursor.lastSequence;
  while (seen.has(advanced + 1)) {
    advanced += 1;
  }

  return {
    zoneId: cursor.zoneId,
    lastSequence: advanced,
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

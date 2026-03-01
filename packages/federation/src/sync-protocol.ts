/**
 * Sync protocol — event-sourced federation sync primitives.
 *
 * SyncClient interface for fetching/publishing events, plus pure functions
 * for cursor advancement, deduplication, and conflict resolution.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import type { FederationSyncEvent, SyncCursor, VectorClock } from "./types.js";
import { mergeClock } from "./vector-clock.js";

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
  readonly client: NexusClient;
}

/** Creates a SyncClient backed by Nexus JSON-RPC. */
export function createNexusSyncClient(config: NexusSyncClientConfig): SyncClient {
  const { client } = config;

  return {
    fetchDelta: async (cursor, maxEvents) => {
      return client.rpc<readonly FederationSyncEvent[]>("federation.sync_fetch_delta", {
        zoneId: cursor.zoneId,
        lastSequence: cursor.lastSequence,
        maxEvents: maxEvents ?? 100,
      });
    },

    publishEvents: async (events) => {
      return client.rpc<void>("federation.sync_publish", {
        events,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a conflict between two concurrent events using LWW (last-writer-wins).
 * The event with the later emittedAt timestamp wins.
 * On tie, the event with the higher origin zone ID wins (deterministic).
 */
export function resolveConflict(
  local: FederationSyncEvent,
  remote: FederationSyncEvent,
): FederationSyncEvent {
  if (local.emittedAt > remote.emittedAt) return local;
  if (remote.emittedAt > local.emittedAt) return remote;
  // Tie-break by zone ID (lexicographic)
  return local.originZoneId >= remote.originZoneId ? local : remote;
}

// ---------------------------------------------------------------------------
// Cursor advancement
// ---------------------------------------------------------------------------

/**
 * Advance a sync cursor after processing a batch of events.
 * Updates lastSequence, vectorClock (merged), and lastSyncAt.
 */
export function advanceCursor(
  cursor: SyncCursor,
  events: readonly FederationSyncEvent[],
): SyncCursor {
  if (events.length === 0) return cursor;

  // let: accumulates max sequence across event batch
  let maxSequence = cursor.lastSequence;
  // let: merged iteratively with each event's vector clock
  let clock: VectorClock = cursor.vectorClock;

  for (const event of events) {
    if (event.sequence > maxSequence) {
      maxSequence = event.sequence;
    }
    clock = mergeClock(clock, event.vectorClock);
  }

  return {
    zoneId: cursor.zoneId,
    vectorClock: clock,
    lastSequence: maxSequence,
    lastSyncAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Deduplication
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

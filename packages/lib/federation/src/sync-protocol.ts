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
 * Advance a sync cursor after processing a batch of events under the
 * v1 wire contract: ascending, contiguous arrival starting at
 * `cursor.lastSequence + 1`. Returns a `Result` so callers can fail
 * closed on protocol faults rather than silently acknowledging an
 * out-of-order or gapped batch.
 *
 * - **Empty batch**: cursor unchanged (`lastSyncAt` bumped).
 * - **Ascending contiguous prefix from cursor**: cursor advances
 *   through the longest such prefix. Trailing events that break the
 *   prefix are reported as a fault and not acknowledged.
 * - **Reordered batch (e.g. `[2,1]`)** or **gap before cursor+1**:
 *   protocol fault. Cursor is NOT advanced — caller must treat the
 *   remote as faulty for this cycle (sync-engine counts it as a
 *   fetch failure toward `offlineAfterFailures`).
 *
 * The strict variant is the only safe one for the wire contract.
 * Permissive contiguous-prefix advancement against unsorted input
 * is intentionally not exported, because it lets a buggy or
 * compromised peer hide events behind reordered batches.
 */
export function advanceCursor(
  cursor: SyncCursor,
  events: readonly FederationSyncEvent[],
  now: number = Date.now(),
): Result<SyncCursor, KoiError> {
  if (events.length === 0) {
    return {
      ok: true,
      value: { zoneId: cursor.zoneId, lastSequence: cursor.lastSequence, lastSyncAt: now },
    };
  }

  // let: walks the expected next sequence; ascending-only.
  let expected = cursor.lastSequence + 1;
  // let: tracks the highest sequence we accepted from this batch.
  let advanced = cursor.lastSequence;
  for (const event of events) {
    // Drop already-acknowledged sequences silently — peers retransmit
    // duplicates legitimately on retry. Only events strictly above the
    // cursor participate in advancement.
    if (event.sequence <= cursor.lastSequence) continue;
    if (event.sequence !== expected) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Sync batch fault for zone "${cursor.zoneId}": expected sequence ${expected}, saw ${event.sequence}. Reordered or gapped batches violate the v1 wire contract; cursor not advanced.`,
          retryable: true,
          context: {
            zoneId: cursor.zoneId,
            expectedSequence: expected,
            sawSequence: event.sequence,
          },
        },
      };
    }
    advanced = event.sequence;
    expected += 1;
  }

  return {
    ok: true,
    value: {
      zoneId: cursor.zoneId,
      lastSequence: advanced,
      lastSyncAt: now,
    },
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

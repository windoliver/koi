/**
 * Sync engine — event-sourced federation sync with adaptive polling,
 * snapshot + truncation, and vector clock pruning.
 */

import type { ZoneId } from "@koi/core";
import { zoneId } from "@koi/core";
import type { SyncClient } from "./sync-protocol.js";
import { advanceCursor, deduplicateEvents } from "./sync-protocol.js";
import type { FederationSyncEvent, SyncCursor } from "./types.js";
import { pruneClock } from "./vector-clock.js";

// ---------------------------------------------------------------------------
// Sync engine config
// ---------------------------------------------------------------------------

/** Config for createSyncEngine. */
export interface SyncEngineConfig {
  readonly localZoneId: ZoneId;
  readonly remoteClients: ReadonlyMap<string, SyncClient>;
  readonly pollIntervalMs: number;
  readonly minPollIntervalMs: number;
  readonly maxPollIntervalMs: number;
  readonly snapshotThreshold: number;
  readonly clockPruneAfterMs: number;
}

// ---------------------------------------------------------------------------
// Sync engine handle
// ---------------------------------------------------------------------------

/** Handle returned by createSyncEngine. */
export interface SyncEngineHandle extends AsyncDisposable {
  /** Trigger an immediate sync cycle for all remote zones. */
  readonly sync: () => Promise<void>;
  /** Get the current cursor for a remote zone. */
  readonly getCursor: (remoteZoneId: string) => SyncCursor | undefined;
  /** Get the event log for a remote zone. */
  readonly getEventLog: (remoteZoneId: string) => readonly FederationSyncEvent[];
  /** Subscribe to incoming sync events. Returns unsubscribe function. */
  readonly onEvent: (handler: (event: FederationSyncEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a sync engine that polls remote zones for new events.
 *
 * Uses adaptive polling: halves interval when events found (floor = minPollIntervalMs),
 * doubles when empty (cap = maxPollIntervalMs). Uses setTimeout (not setInterval)
 * for dynamic interval changes.
 */
export function createSyncEngine(config: SyncEngineConfig): SyncEngineHandle {
  const {
    remoteClients,
    pollIntervalMs,
    minPollIntervalMs,
    maxPollIntervalMs,
    snapshotThreshold,
    clockPruneAfterMs,
  } = config;

  // Per-zone state
  const cursors = new Map<string, SyncCursor>();
  const eventLogs = new Map<string, FederationSyncEvent[]>();
  const lastActiveTimes = new Map<string, number>();

  // Initialize cursors for each remote zone
  for (const remoteId of remoteClients.keys()) {
    cursors.set(remoteId, {
      zoneId: zoneId(remoteId),
      vectorClock: {},
      lastSequence: 0,
      lastSyncAt: 0,
    });
    eventLogs.set(remoteId, []);
  }

  // let: reassigned on subscribe/unsubscribe (immutable swap pattern)
  let handlers: ReadonlySet<(event: FederationSyncEvent) => void> = new Set();

  function notifyHandlers(event: FederationSyncEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (_: unknown) {
        // Listener errors must not disrupt sync processing.
        // Callers are responsible for their own error handling.
      }
    }
  }

  // let: mutated by adaptive polling algorithm
  let currentInterval = pollIntervalMs;
  // let: reassigned on each poll cycle, cleared on dispose
  let timerId: ReturnType<typeof setTimeout> | undefined;
  // let: set to true on dispose to stop polling
  let disposed = false;
  // let: in-flight guard — prevents overlapping syncAll() calls
  let syncing = false;

  /** Result of a single zone sync: event count + whether an error occurred. */
  interface SyncZoneResult {
    readonly count: number;
    readonly errored: boolean;
  }

  /** Sync a single remote zone. Returns event count and error status. */
  async function syncZone(remoteId: string, client: SyncClient): Promise<SyncZoneResult> {
    const cursor = cursors.get(remoteId);
    if (cursor === undefined) return { count: 0, errored: false };

    const result = await client.fetchDelta(cursor);
    if (!result.ok) return { count: 0, errored: true };

    const newEvents = deduplicateEvents(result.value, cursor);
    if (newEvents.length === 0) return { count: 0, errored: false };

    // Process events
    for (const event of newEvents) {
      notifyHandlers(event);
    }

    // Update cursor
    const updatedCursor = advanceCursor(cursor, newEvents);
    cursors.set(remoteId, updatedCursor);

    // Append to event log
    const log = eventLogs.get(remoteId) ?? [];
    const updatedLog = [...log, ...newEvents];

    // Snapshot + truncation: keep newest threshold/2 entries
    if (updatedLog.length > snapshotThreshold) {
      const keepCount = Math.floor(snapshotThreshold / 2);
      eventLogs.set(remoteId, updatedLog.slice(-keepCount));
    } else {
      eventLogs.set(remoteId, updatedLog);
    }

    // Track activity
    lastActiveTimes.set(remoteId, Date.now());

    return { count: newEvents.length, errored: false };
  }

  /** Sync all remote zones in parallel. Guarded against overlapping calls. */
  async function syncAll(): Promise<void> {
    if (syncing) return;
    syncing = true;

    try {
      const results = await Promise.allSettled(
        [...remoteClients.entries()].map(([remoteId, client]) => syncZone(remoteId, client)),
      );

      const totalEvents = results.reduce(
        (sum, r) => sum + (r.status === "fulfilled" ? r.value.count : 0),
        0,
      );
      const anyErrored = results.some(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.errored),
      );

      // Adaptive polling — errors hold interval steady (don't back off on failures)
      if (totalEvents > 0) {
        // Events found → halve interval (floor = minPollIntervalMs)
        currentInterval = Math.max(minPollIntervalMs, Math.floor(currentInterval / 2));
      } else if (!anyErrored) {
        // Truly idle (no events AND no errors) → double interval (cap = maxPollIntervalMs)
        currentInterval = Math.min(maxPollIntervalMs, currentInterval * 2);
      }
      // On error with no events: hold current interval (don't back off)

      // Vector clock pruning
      const cutoffAt = Date.now() - clockPruneAfterMs;
      const activeMap: Record<string, number> = {};
      for (const [id, time] of lastActiveTimes) {
        activeMap[id] = time;
      }
      for (const [id, cursor] of cursors) {
        const prunedClock = pruneClock(cursor.vectorClock, activeMap, cutoffAt);
        cursors.set(id, { ...cursor, vectorClock: prunedClock });
      }
    } finally {
      syncing = false;
    }
  }

  /** Schedule the next poll cycle. */
  function scheduleNext(): void {
    if (disposed) return;
    timerId = setTimeout(() => {
      if (disposed) return;
      syncAll()
        .catch(() => {
          // Sync failures are transient (network, Nexus down).
          // Adaptive polling backs off on next empty cycle.
        })
        .finally(() => {
          scheduleNext();
        });
    }, currentInterval);
  }

  // Start polling
  scheduleNext();

  return {
    sync: async () => {
      await syncAll();
    },

    getCursor: (remoteZoneId) => {
      return cursors.get(remoteZoneId);
    },

    getEventLog: (remoteZoneId) => {
      const log = eventLogs.get(remoteZoneId);
      return log !== undefined ? [...log] : [];
    },

    onEvent: (handler) => {
      handlers = new Set([...handlers, handler]);
      return () => {
        const next = new Set(handlers);
        next.delete(handler);
        handlers = next;
      };
    },

    [Symbol.asyncDispose]: async () => {
      disposed = true;
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
      handlers = new Set();
      cursors.clear();
      eventLogs.clear();
    },
  };
}

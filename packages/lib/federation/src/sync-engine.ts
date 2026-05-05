/**
 * Sync engine — fixed-interval sequence-cursor federation sync (Phase 3 baseline).
 *
 * Polls each remote SyncClient on a fixed interval. Tracks consecutive failures
 * per remote and marks zones offline locally after `offlineAfterFailures`
 * threshold. On dispose, sends a best-effort `federation.zone_disconnect`
 * notification to the local-zone-bound transport (if provided).
 *
 * Adaptive polling, snapshot truncation, vector clocks, and clock pruning are
 * deferred to #1410 (Phase 4e).
 */

import type { ZoneId, ZoneStatus } from "@koi/core";
import { zoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { SyncClient } from "./sync-protocol.js";
import { advanceCursor, deduplicateEvents } from "./sync-protocol.js";
import type { FederationSyncEvent, SyncCursor } from "./types.js";

// ---------------------------------------------------------------------------
// Sync engine config
// ---------------------------------------------------------------------------

/** Per-remote-zone health snapshot. */
export interface RemoteHealth {
  readonly status: ZoneStatus;
  readonly consecutiveFailures: number;
  readonly lastSyncAt: number;
}

/** Config for createSyncEngine. */
export interface SyncEngineConfig {
  readonly localZoneId: ZoneId;
  readonly remoteClients: ReadonlyMap<string, SyncClient>;
  readonly pollIntervalMs: number;
  /** Mark a remote offline locally after N consecutive fetch failures. */
  readonly offlineAfterFailures: number;
  /**
   * Optional transport bound to the federation hub. Used on dispose() to send
   * `federation.zone_disconnect` so the hub can mark this local zone draining
   * immediately rather than waiting for the heartbeat timeout.
   */
  readonly hubTransport?: NexusTransport | undefined;
}

/** Handle returned by createSyncEngine. */
export interface SyncEngineHandle extends AsyncDisposable {
  /** Trigger an immediate sync cycle for all remote zones. */
  readonly sync: () => Promise<void>;
  /** Get the current cursor for a remote zone. */
  readonly getCursor: (remoteZoneId: string) => SyncCursor | undefined;
  /** Get the event log for a remote zone. */
  readonly getEventLog: (remoteZoneId: string) => readonly FederationSyncEvent[];
  /** Get health snapshot for a remote zone. */
  readonly getHealth: (remoteZoneId: string) => RemoteHealth | undefined;
  /** Subscribe to incoming sync events. Returns unsubscribe function. */
  readonly onEvent: (handler: (event: FederationSyncEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a sync engine that polls remote zones for new events at a fixed interval.
 */
export function createSyncEngine(config: SyncEngineConfig): SyncEngineHandle {
  const { localZoneId, remoteClients, pollIntervalMs, offlineAfterFailures, hubTransport } = config;

  // Per-zone state
  const cursors = new Map<string, SyncCursor>();
  const eventLogs = new Map<string, readonly FederationSyncEvent[]>();
  const failures = new Map<string, number>();
  const statuses = new Map<string, ZoneStatus>();

  for (const remoteId of remoteClients.keys()) {
    cursors.set(remoteId, {
      zoneId: zoneId(remoteId),
      lastSequence: 0,
      lastSyncAt: 0,
    });
    eventLogs.set(remoteId, []);
    failures.set(remoteId, 0);
    statuses.set(remoteId, "active");
  }

  // let: reassigned on subscribe/unsubscribe (immutable swap pattern)
  let handlers: ReadonlySet<(event: FederationSyncEvent) => void> = new Set();

  function notifyHandlers(event: FederationSyncEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (_: unknown) {
        // Listener errors must not disrupt sync processing.
      }
    }
  }

  // let: reassigned on each poll cycle, cleared on dispose
  let timerId: ReturnType<typeof setTimeout> | undefined;
  // let: set to true on dispose to stop polling
  let disposed = false;
  // let: in-flight guard — prevents overlapping syncAll() calls
  let syncing = false;

  /** Sync a single remote zone. */
  async function syncZone(remoteId: string, client: SyncClient): Promise<void> {
    const cursor = cursors.get(remoteId);
    if (cursor === undefined) return;

    const result = await client.fetchDelta(cursor);
    if (!result.ok) {
      const next = (failures.get(remoteId) ?? 0) + 1;
      failures.set(remoteId, next);
      if (next >= offlineAfterFailures) {
        statuses.set(remoteId, "offline");
      }
      return;
    }

    // Successful fetch — reset failures, restore active status
    failures.set(remoteId, 0);
    statuses.set(remoteId, "active");

    const newEvents = deduplicateEvents(result.value, cursor);
    if (newEvents.length === 0) {
      cursors.set(remoteId, advanceCursor(cursor, []));
      return;
    }

    for (const event of newEvents) {
      notifyHandlers(event);
    }

    cursors.set(remoteId, advanceCursor(cursor, newEvents));
    const log = eventLogs.get(remoteId) ?? [];
    eventLogs.set(remoteId, [...log, ...newEvents]);
  }

  async function syncAll(): Promise<void> {
    if (syncing || disposed) return;
    syncing = true;
    try {
      await Promise.allSettled(
        [...remoteClients.entries()].map(([remoteId, client]) => syncZone(remoteId, client)),
      );
    } finally {
      syncing = false;
    }
  }

  function scheduleNext(): void {
    if (disposed) return;
    timerId = setTimeout(() => {
      if (disposed) return;
      syncAll()
        .catch(() => {
          // Sync failures handled per-zone; promise itself swallows residual errors.
        })
        .finally(() => {
          scheduleNext();
        });
    }, pollIntervalMs);
  }

  scheduleNext();

  return {
    sync: async () => {
      await syncAll();
    },

    getCursor: (remoteZoneId) => cursors.get(remoteZoneId),

    getEventLog: (remoteZoneId) => {
      const log = eventLogs.get(remoteZoneId);
      return log !== undefined ? [...log] : [];
    },

    getHealth: (remoteZoneId) => {
      const cursor = cursors.get(remoteZoneId);
      const status = statuses.get(remoteZoneId);
      if (cursor === undefined || status === undefined) return undefined;
      return {
        status,
        consecutiveFailures: failures.get(remoteZoneId) ?? 0,
        lastSyncAt: cursor.lastSyncAt,
      };
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
      failures.clear();
      statuses.clear();

      // Best-effort graceful disconnect — errors are swallowed so dispose() is
      // robust to a hub that's already gone.
      if (hubTransport !== undefined) {
        try {
          await hubTransport.call<void>("federation.zone_disconnect", {
            zoneId: localZoneId,
          });
        } catch (_: unknown) {
          // intentional: dispose() must not throw.
        }
      }
    },
  };
}

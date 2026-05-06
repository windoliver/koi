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
   * Strict wire-protocol-v1 batch validation. When `true` (default),
   * non-contiguous, reordered, or duplicate-conflicting batches are
   * treated as protocol faults and counted toward `offlineAfterFailures`.
   * When `false`, the engine falls back to permissive replication: it
   * delivers any contiguous prefix it can find without faulting on gaps.
   * The permissive mode exists to avoid partitioning federation during
   * rolling upgrades against pre-v1 peers — set to `false` only for
   * peers that haven't been upgraded to advertise v1 contract support.
   */
  readonly strictV1?: boolean;
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
  const strictV1 = config.strictV1 ?? true;

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

    // Reject events whose claimed origin doesn't match the queried remote.
    // A buggy or compromised remote must not be able to inject events
    // masquerading as another zone. Treat mismatches as a protocol fault:
    // count as failure, do not advance the cursor.
    const spoofed = result.value.some((e) => e.originZoneId !== remoteId);
    if (spoofed) {
      const next = (failures.get(remoteId) ?? 0) + 1;
      failures.set(remoteId, next);
      if (next >= offlineAfterFailures) {
        statuses.set(remoteId, "offline");
      }
      return;
    }

    const newEvents = deduplicateEvents(result.value, cursor);
    if (newEvents.length === 0) {
      // Empty fetch is a clean liveness signal — reset health.
      failures.set(remoteId, 0);
      statuses.set(remoteId, "active");
      cursors.set(remoteId, advanceCursor(cursor, []));
      return;
    }

    const validation = validateV1Batch(newEvents, cursor.lastSequence);

    if (!validation.ok) {
      if (strictV1) {
        const next = (failures.get(remoteId) ?? 0) + 1;
        failures.set(remoteId, next);
        if (next >= offlineAfterFailures) {
          statuses.set(remoteId, "offline");
        }
        return;
      }
      // Permissive mode: deliver the contiguous prefix the validator was
      // able to recognize and continue. Used during rolling upgrades
      // against pre-v1 peers; never the safer default.
    }

    const deliverable = validation.prefix;
    if (deliverable.length === 0) {
      // Permissive mode with nothing safe to deliver — count a failure
      // so a perpetually broken remote still surfaces eventually.
      const next = (failures.get(remoteId) ?? 0) + 1;
      failures.set(remoteId, next);
      if (next >= offlineAfterFailures) {
        statuses.set(remoteId, "offline");
      }
      return;
    }

    // Forward progress — reset health, deliver the validated prefix.
    failures.set(remoteId, 0);
    statuses.set(remoteId, "active");

    for (const event of deliverable) {
      notifyHandlers(event);
    }

    cursors.set(remoteId, advanceCursor(cursor, deliverable));
    const log = eventLogs.get(remoteId) ?? [];
    eventLogs.set(remoteId, [...log, ...deliverable]);
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

/**
 * Validate a sync batch against wire-protocol v1:
 *   - sequences form a strict contiguous ascending run starting at
 *     `lastSequence + 1`
 *   - events appear in ascending order (byte-identical duplicates ok)
 *   - duplicate sequences with mismatched payloads are faults
 *
 * Returns `ok: true` plus the deduped contiguous prefix on success.
 * Returns `ok: false` plus the contiguous prefix the validator was able
 * to recognize before the fault — callers in permissive (non-strict)
 * mode can still deliver that prefix safely.
 */
interface BatchValidation {
  readonly ok: boolean;
  readonly prefix: readonly FederationSyncEvent[];
}

function validateV1Batch(
  events: readonly FederationSyncEvent[],
  cursorLastSequence: number,
): BatchValidation {
  const seenAtSeq = new Map<number, FederationSyncEvent>();
  const dedupedInOrder: FederationSyncEvent[] = [];
  let lastSeqSeen = cursorLastSequence;
  for (const event of events) {
    const prior = seenAtSeq.get(event.sequence);
    if (prior !== undefined) {
      if (!sameEvent(prior, event)) {
        return { ok: false, prefix: dedupedInOrder };
      }
      continue;
    }
    if (event.sequence <= lastSeqSeen || event.sequence !== lastSeqSeen + 1) {
      return { ok: false, prefix: dedupedInOrder };
    }
    seenAtSeq.set(event.sequence, event);
    dedupedInOrder.push(event);
    lastSeqSeen = event.sequence;
  }
  return { ok: true, prefix: dedupedInOrder };
}

/**
 * Deep-equal two FederationSyncEvent envelopes. Used to detect a remote
 * returning conflicting payloads under the same sequence number — a
 * protocol fault that must not silently advance the cursor.
 */
function sameEvent(a: FederationSyncEvent, b: FederationSyncEvent): boolean {
  if (a === b) return true;
  if (
    a.kind !== b.kind ||
    a.originZoneId !== b.originZoneId ||
    a.sequence !== b.sequence ||
    a.emittedAt !== b.emittedAt
  ) {
    return false;
  }
  // data is JsonObject — JSON.stringify with sorted keys gives a stable form.
  return stableStringify(a.data) === stableStringify(b.data);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

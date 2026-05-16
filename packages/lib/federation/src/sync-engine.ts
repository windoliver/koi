/**
 * Sync engine — fixed-interval sequence-cursor federation sync.
 *
 * Polls each remote SyncClient on a fixed interval. Tracks consecutive failures
 * per remote and marks zones offline locally after `offlineAfterFailures`
 * threshold. On dispose, sends a best-effort `federation.zone_disconnect`
 * notification to the local-zone-bound transport (if provided).
 *
 * Tracks vector-clock metadata and reports concurrent shared-resource writes.
 */

import type { ZoneId, ZoneStatus } from "@koi/core";
import { zoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { SyncClient } from "./sync-protocol.js";
import { advanceCursor, deduplicateEvents, isFederationSyncEvent } from "./sync-protocol.js";
import type {
  ConflictResolutionStrategy,
  FederationSyncEvent,
  ReportedConflict,
  SyncCursor,
} from "./types.js";
import { FEDERATION_PROTOCOL_VERSION } from "./types.js";
import {
  detectEventConflict,
  getConflictResourceKey,
  resolveEventConflict,
} from "./vector-clock.js";

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
   * Per-zone fetchDelta timeout in milliseconds. Default 30_000 (30s).
   * A timeout is treated as a fetch failure for that zone — bumps the
   * consecutive-failure counter. Prevents one hung remote from stalling
   * replication for healthy peers.
   */
  readonly fetchTimeoutMs?: number;
  /**
   * Maximum age (ms) before an outstanding fetchDelta is treated as
   * leaked. Defaults to 5x `fetchTimeoutMs`.
   *
   * **This does NOT auto-recover replication.** When the threshold is
   * crossed, the engine marks the zone offline (so health surfaces the
   * stall) but **keeps the slot reserved** until the original promise
   * eventually settles. A new fetch can only run after that settlement
   * — without remote-side dedup/cancel, issuing a replacement fetch
   * would risk double-publish/double-consume on the peer. Phase 3
   * baseline accepts this stall trade-off; structural recovery (signed
   * cancel + remote idempotency tokens) is tracked in #1410.
   *
   * Operators monitoring `getHealth(zone) === "offline"` together with
   * a stuck cursor can detect the condition; full recovery currently
   * requires process restart if the leaked promise never settles.
   */
  readonly outstandingFetchMaxAgeMs?: number;
  /**
   * Maximum number of replicated events retained per remote zone in
   * memory. **Default 10_000** — bounded by default so a long-lived
   * federated deployment cannot grow per-zone logs without limit.
   * Older entries are evicted when the log exceeds the cap, and the
   * evicted count is exposed via `getTruncatedCount(remoteZoneId)`
   * so callers can detect that `getEventLog()` is no longer a
   * complete history. Pass `Number.POSITIVE_INFINITY` to opt into
   * the legacy unbounded mode (e.g. for short-lived test runs); the
   * caller takes responsibility for the resulting memory growth.
   */
  readonly eventLogMaxPerZone?: number;
  /**
   * Strategy used when vector clocks reveal concurrent writes to the
   * same declared shared resource. Defaults to last-writer-wins.
   */
  readonly conflictResolution?: ConflictResolutionStrategy;
  /**
   * Optional transport bound to the federation hub. Used on dispose() to send
   * `federation.zone_disconnect` so the hub can mark this local zone draining
   * immediately rather than waiting for the heartbeat timeout.
   */
  readonly hubTransport?: NexusTransport | undefined;
  /**
   * Optional initial cursors keyed by remote zone id. Lets callers
   * restore replication progress from durable storage on engine
   * construction so a process restart does NOT re-emit already-
   * processed remote events from `lastSequence: 0`.
   *
   * For each remote in `remoteClients`, the engine first looks up
   * an entry here; if present, that cursor seeds replication.
   * Otherwise the cursor starts at `{ lastSequence: 0 }` (Phase 3
   * baseline default — non-idempotent event handlers must use this
   * field plus their own checkpoint store to avoid duplicate side
   * effects across restarts). Durable checkpointing inside the engine
   * is tracked in #1410.
   */
  readonly initialCursors?: ReadonlyMap<string, SyncCursor>;
}

/** Handle returned by createSyncEngine. */
export interface SyncEngineHandle extends AsyncDisposable {
  /** Trigger an immediate sync cycle for all remote zones. */
  readonly sync: () => Promise<void>;
  /** Get the current cursor for a remote zone. */
  readonly getCursor: (remoteZoneId: string) => SyncCursor | undefined;
  /**
   * Get the in-memory event log for a remote zone. When
   * `eventLogMaxPerZone` is finite, this is a bounded ring buffer of
   * the most-recent events — use `getTruncatedCount()` to detect when
   * older events have been dropped.
   */
  readonly getEventLog: (remoteZoneId: string) => readonly FederationSyncEvent[];
  /** Number of events evicted from `getEventLog()` due to ring-buffer cap. */
  readonly getTruncatedCount: (remoteZoneId: string) => number;
  /** Get health snapshot for a remote zone. */
  readonly getHealth: (remoteZoneId: string) => RemoteHealth | undefined;
  /** Subscribe to incoming sync events. Returns unsubscribe function. */
  readonly onEvent: (handler: (event: FederationSyncEvent) => void) => () => void;
  /** Subscribe to conflict reports. Returns unsubscribe function. */
  readonly onConflict: (handler: (report: ReportedConflict) => void) => () => void;
  /** Get conflict reports observed by this engine. */
  readonly getConflictReports: () => readonly ReportedConflict[];
  /**
   * Operator-visible recovery for a wedged remote: clears any
   * outstanding fetch slot for the zone so the next sync cycle can
   * issue a fresh `fetchDelta`, and resets health from `offline` to
   * `active` with the failure counter at 0. Use this after operator
   * confirms the leaked transport promise will never settle (e.g.
   * underlying TCP/HTTP client was reset out-of-band) — without
   * this, the zone would stay offline until process restart.
   *
   * Returns `true` if a slot was cleared, `false` if the zone has
   * no outstanding fetch (no-op).
   */
  readonly forceResetZone: (remoteZoneId: string) => boolean;
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
  const fetchTimeoutMs = config.fetchTimeoutMs ?? 30_000;
  const eventLogMaxPerZone = config.eventLogMaxPerZone ?? 10_000;
  const outstandingFetchMaxAgeMs = config.outstandingFetchMaxAgeMs ?? fetchTimeoutMs * 5;
  const conflictResolution = config.conflictResolution ?? "lww";

  // Validate the new tunables — silent misconfiguration here can
  // recreate the overlap/stall hazards the timeout machinery is
  // designed to prevent.
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      `createSyncEngine: pollIntervalMs must be a positive finite number (got ${pollIntervalMs})`,
    );
  }
  if (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
    throw new Error(
      `createSyncEngine: fetchTimeoutMs must be a positive finite number (got ${fetchTimeoutMs})`,
    );
  }
  if (!Number.isFinite(outstandingFetchMaxAgeMs) || outstandingFetchMaxAgeMs <= 0) {
    throw new Error(
      `createSyncEngine: outstandingFetchMaxAgeMs must be a positive finite number (got ${outstandingFetchMaxAgeMs})`,
    );
  }
  if (outstandingFetchMaxAgeMs < fetchTimeoutMs) {
    throw new Error(
      `createSyncEngine: outstandingFetchMaxAgeMs (${outstandingFetchMaxAgeMs}) must be >= fetchTimeoutMs (${fetchTimeoutMs}); a smaller value evicts outstanding fetches before they time out and reintroduces overlapping RPCs against degraded peers`,
    );
  }
  // eventLogMaxPerZone may be Infinity (unbounded, the default) but
  // not NaN, negative, or zero.
  if (
    !(eventLogMaxPerZone === Number.POSITIVE_INFINITY) &&
    (!Number.isFinite(eventLogMaxPerZone) || eventLogMaxPerZone <= 0)
  ) {
    throw new Error(
      `createSyncEngine: eventLogMaxPerZone must be a positive finite number or Infinity (got ${eventLogMaxPerZone})`,
    );
  }
  if (!Number.isInteger(offlineAfterFailures) || offlineAfterFailures <= 0) {
    throw new Error(
      `createSyncEngine: offlineAfterFailures must be a positive integer (got ${offlineAfterFailures})`,
    );
  }
  if (!isConflictResolutionStrategy(conflictResolution)) {
    throw new Error(
      `createSyncEngine: conflictResolution must be one of lww, merge, manual (got ${String(conflictResolution)})`,
    );
  }

  // Per-zone state
  const cursors = new Map<string, SyncCursor>();
  const eventLogs = new Map<string, readonly FederationSyncEvent[]>();
  const conflictReports: ReportedConflict[] = [];
  const truncatedCounts = new Map<string, number>();
  const failures = new Map<string, number>();
  const statuses = new Map<string, ZoneStatus>();
  /**
   * Outstanding fetchDelta token per zone. The token is a per-fetch
   * unique symbol so a settling promise can only clear the map entry
   * if it still owns the current slot. Without that check, an old
   * promise that finally settles AFTER a replacement was already
   * started would delete the replacement's entry, allowing a third
   * RPC to overlap. Cleared when the original promise settles OR when
   * the entry has been outstanding longer than
   * `outstandingFetchMaxAgeMs` (recovery path for transports that
   * leak never-settling promises).
   */
  const outstandingFetches = new Map<string, { startedAt: number; token: symbol }>();

  // Fail-closed validation of any caller-supplied checkpoint state.
  // A stale or corrupt persisted cursor (too high, wrong remote zone,
  // non-finite, negative) would otherwise cause silent replay loss:
  // dedup drops everything, the empty post-dedup batch resets health
  // to active, and the zone looks normal while all skipped events
  // are gone forever. Reject obviously-broken state at construction.
  if (config.initialCursors !== undefined) {
    for (const [remoteId, seed] of config.initialCursors.entries()) {
      if (!remoteClients.has(remoteId)) {
        throw new Error(
          `createSyncEngine: initialCursors contains zone "${remoteId}" which is not in remoteClients`,
        );
      }
      if (seed.zoneId !== remoteId) {
        throw new Error(
          `createSyncEngine: initialCursors["${remoteId}"].zoneId is "${seed.zoneId}"; must equal the map key`,
        );
      }
      if (
        !Number.isInteger(seed.lastSequence) ||
        seed.lastSequence < 0 ||
        !Number.isFinite(seed.lastSequence)
      ) {
        throw new Error(
          `createSyncEngine: initialCursors["${remoteId}"].lastSequence must be a non-negative integer (got ${seed.lastSequence})`,
        );
      }
      if (!Number.isFinite(seed.lastSyncAt) || seed.lastSyncAt < 0) {
        throw new Error(
          `createSyncEngine: initialCursors["${remoteId}"].lastSyncAt must be a finite non-negative number (got ${seed.lastSyncAt})`,
        );
      }
      if (seed.vectorClock !== undefined && !isValidVectorClock(seed.vectorClock)) {
        throw new Error(
          `createSyncEngine: initialCursors["${remoteId}"].vectorClock must contain only non-negative integer components`,
        );
      }
    }
  }

  for (const remoteId of remoteClients.keys()) {
    // Honor caller-supplied checkpoint when present so a restart
    // does not replay already-processed history from sequence 0.
    const seed = config.initialCursors?.get(remoteId);
    cursors.set(
      remoteId,
      seed ?? {
        zoneId: zoneId(remoteId),
        lastSequence: 0,
        lastSyncAt: 0,
      },
    );
    eventLogs.set(remoteId, []);
    truncatedCounts.set(remoteId, 0);
    failures.set(remoteId, 0);
    statuses.set(remoteId, "active");
  }

  // let: reassigned on subscribe/unsubscribe (immutable swap pattern)
  let handlers: ReadonlySet<(event: FederationSyncEvent) => void> = new Set();
  // let: reassigned on subscribe/unsubscribe (immutable swap pattern)
  let conflictHandlers: ReadonlySet<(report: ReportedConflict) => void> = new Set();

  /**
   * Deliver an event to every subscribed handler. Returns `true` only
   * if every handler accepted the event without throwing. Callers use
   * the return value to decide whether the cursor may safely advance:
   * advancing past an event a handler refused would be silent data
   * loss (the next sync starts from a higher cursor and never
   * redelivers). Handler errors do NOT short-circuit delivery to
   * later handlers — each subscriber is independent.
   */
  function notifyHandlers(event: FederationSyncEvent): boolean {
    // let: walks handlers, OR-folds any caught error into the result.
    let allOk = true;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (_: unknown) {
        allOk = false;
      }
    }
    return allOk;
  }

  function notifyConflictHandlers(report: ReportedConflict): void {
    for (const handler of conflictHandlers) {
      try {
        handler(report);
      } catch (_: unknown) {
        // Conflict reporting is advisory for UI/telemetry; event delivery
        // and cursor advancement must not depend on a view callback.
      }
    }
  }

  function reportConflicts(events: readonly FederationSyncEvent[]): void {
    const existingEvents = [...eventLogs.values()].flat();
    for (const remote of events) {
      for (const local of existingEvents) {
        if (!detectEventConflict(local, remote)) continue;
        const resolution = resolveEventConflict(local, remote, conflictResolution);
        const resourceKey =
          resolution.kind === "manual"
            ? resolution.report.resourceKey
            : (getConflictResourceKey(local) ?? getConflictResourceKey(remote) ?? "");
        const report: ReportedConflict = {
          resourceKey,
          order: "concurrent",
          local,
          remote,
          strategy: conflictResolution,
          resolution,
        };
        conflictReports.push(report);
        notifyConflictHandlers(report);
      }
    }
  }

  // let: reassigned on each poll cycle, cleared on dispose
  let timerId: ReturnType<typeof setTimeout> | undefined;
  // let: set to true on dispose to stop polling
  let disposed = false;
  // Per-zone in-flight set: each zone syncs independently so one hung
  // remote cannot block syncs on healthy peers. The previous global
  // `syncing` latch was removed for this reason.
  const inflight = new Set<string>();

  function bumpFailure(remoteId: string): void {
    const next = (failures.get(remoteId) ?? 0) + 1;
    failures.set(remoteId, next);
    if (next >= offlineAfterFailures) {
      statuses.set(remoteId, "offline");
    }
  }

  /** Sync a single remote zone. */
  async function syncZone(remoteId: string, client: SyncClient): Promise<void> {
    if (disposed) return;
    const cursor = cursors.get(remoteId);
    if (cursor === undefined) return;

    // Skip if a recent fetch for this zone is still outstanding
    // (timed-out earlier but still hung remotely). Prevents unbounded
    // stacking of concurrent RPCs.
    //
    // After outstandingFetchMaxAgeMs without settlement, evict the
    // stale entry AND mark the zone offline immediately — without
    // server-side cancellation/dedup, dispatching a replacement is the
    // only thing that creates real overlap against the remote, so
    // we refuse to do so. The zone stays offline (no further fetches)
    // until callers explicitly recover (e.g. via a future
    // sync_fetch_delta capability that includes a fetchId for server
    // dedup, deferred to #1410).
    const existing = outstandingFetches.get(remoteId);
    if (existing !== undefined) {
      if (Date.now() - existing.startedAt < outstandingFetchMaxAgeMs) {
        return;
      }
      // Stale (likely leaked) outstanding fetch. Mark the zone offline
      // and do NOT dispatch a replacement — without a server-side
      // cancel/dedup contract (#1410), starting a new fetch would
      // overlap with the original on the remote. Keep the outstanding
      // entry in place: when the original promise eventually settles,
      // its tokenized .finally will clear the slot, allowing recovery
      // on a later sync. If it never settles, the zone stays offline
      // until process restart — the safer of the two failure modes.
      statuses.set(remoteId, "offline");
      failures.set(remoteId, offlineAfterFailures);
      return;
    }

    // Per-zone fetchDelta timeout: a hung remote becomes a counted
    // failure for that zone instead of a stuck promise that blocks
    // replication for everyone.
    //
    // Wrap the invocation in `Promise.resolve().then(...)` so that a
    // SyncClient that throws synchronously (custom impl, transport
    // bug, etc.) lands as a rejected promise instead of escaping
    // syncZone() before bumpFailure() can fire. Without the wrap, a
    // sync throw would surface only as an unhandled rejection swallowed
    // by Promise.allSettled in syncAll(), leaving the zone stuck-active.
    const fetchPromise = Promise.resolve().then(() => client.fetchDelta(cursor));
    const fetchToken = Symbol("fetch");
    outstandingFetches.set(remoteId, { startedAt: Date.now(), token: fetchToken });
    // Clear the entry only if THIS fetch still owns it. A stale
    // completion (older fetch settling after eviction + replacement)
    // must not delete a newer in-flight marker.
    fetchPromise
      .catch(() => {
        // suppress unhandled rejection
      })
      .finally(() => {
        const current = outstandingFetches.get(remoteId);
        if (current?.token === fetchToken) {
          outstandingFetches.delete(remoteId);
        }
      });

    const timeoutSentinel = Symbol("fetch-timeout");
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutId = setTimeout(() => resolve(timeoutSentinel), fetchTimeoutMs);
    });
    // SyncClient implementations are expected to return Result, but a
    // buggy transport, custom client, or thrown timeout wrapper may
    // reject instead. Treat rejection identically to Result.error so
    // the remote eventually transitions offline rather than staying
    // active with a stuck cursor — the silent-replication-failure
    // mode is exactly what offlineAfterFailures is meant to surface.
    let raced: Awaited<typeof fetchPromise> | typeof timeoutSentinel;
    try {
      raced = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (_e: unknown) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      bumpFailure(remoteId);
      return;
    }
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    // Re-check disposal: dispose() may have run while we were awaiting
    // the fetch. Without this guard, a late successful response would
    // continue mutating cursors/eventLogs/handlers/statuses, violating
    // the contract that disposal is terminal and leaking memory after
    // teardown.
    if (disposed) return;
    if (raced === timeoutSentinel) {
      // Timeout: count failure NOW. The original fetchPromise stays in
      // outstandingFetches and will only be cleared when it eventually
      // settles — guaranteeing no overlapping RPC is launched.
      bumpFailure(remoteId);
      return;
    }
    const result = raced;
    if (!result.ok) {
      bumpFailure(remoteId);
      return;
    }

    // Defensive validation at the engine/SyncClient boundary. The
    // bundled createNexusSyncClient already validates this, but the
    // SyncClient interface accepts arbitrary implementations, and a
    // custom or buggy client returning ok:true with a non-array or
    // malformed event would otherwise throw on the .some(...) call
    // and escape into Promise.allSettled — leaving the zone "active"
    // with a stuck cursor.
    if (!Array.isArray(result.value)) {
      bumpFailure(remoteId);
      return;
    }
    // Use the shared full-envelope guard — a weak check would let a
    // custom SyncClient slip through events with NaN/Infinity/negative
    // sequence, empty kind, or non-object data. Those would then be
    // dropped by deduplicateEvents() (sequence comparison fails),
    // leaving newEvents empty and the empty-batch path resetting the
    // zone to "active" — silently masking corruption.
    for (const ev of result.value) {
      if (!isFederationSyncEvent(ev)) {
        bumpFailure(remoteId);
        return;
      }
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
      const advanced = advanceCursor(cursor, []);
      if (advanced.ok) cursors.set(remoteId, advanced.value);
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

    // Deliver the validated prefix BEFORE advancing the cursor so a
    // handler failure cannot silently strand events past the cursor.
    // Stop at the first event a handler refused: all earlier events
    // were accepted, so it's safe to advance the cursor through the
    // delivered prefix; the failed event and the rest will be
    // redelivered on the next sync. Counted as a retryable failure
    // toward offlineAfterFailures so a perpetually-failing handler
    // surfaces in health rather than silently looping forever.
    // let: walks the deliverable batch up to the first handler refusal.
    let deliveredCount = 0;
    // let: flips on the first handler exception in the batch.
    let handlerFailed = false;
    for (const event of deliverable) {
      const ok = notifyHandlers(event);
      if (!ok) {
        handlerFailed = true;
        break;
      }
      deliveredCount += 1;
    }

    if (handlerFailed) {
      const next = (failures.get(remoteId) ?? 0) + 1;
      failures.set(remoteId, next);
      if (next >= offlineAfterFailures) {
        statuses.set(remoteId, "offline");
      }
    } else {
      // Forward progress — reset health when every handler accepted.
      failures.set(remoteId, 0);
      statuses.set(remoteId, "active");
    }

    const accepted = deliverable.slice(0, deliveredCount);
    if (accepted.length === 0) return;

    const advanced = advanceCursor(cursor, accepted);
    if (advanced.ok) {
      cursors.set(remoteId, advanced.value);
    } else {
      // The validator already accepted this prefix as ascending+
      // contiguous, so a fault here would indicate a bug in this
      // module rather than a remote protocol violation. Count it as
      // a failure and bail out of state mutation rather than write a
      // half-progressed cursor.
      const next = (failures.get(remoteId) ?? 0) + 1;
      failures.set(remoteId, next);
      if (next >= offlineAfterFailures) {
        statuses.set(remoteId, "offline");
      }
      return;
    }
    reportConflicts(accepted);
    const log = eventLogs.get(remoteId) ?? [];
    const merged = [...log, ...accepted];
    // Optional ring-buffer cap. Default is unbounded — opt in by setting
    // a finite eventLogMaxPerZone. When the cap fires, track the number
    // of evicted events so callers can detect the gap via
    // getTruncatedCount() instead of silently mistaking the bounded
    // log for a complete history.
    if (merged.length > eventLogMaxPerZone) {
      const evicted = merged.length - eventLogMaxPerZone;
      truncatedCounts.set(remoteId, (truncatedCounts.get(remoteId) ?? 0) + evicted);
      eventLogs.set(remoteId, merged.slice(evicted));
    } else {
      eventLogs.set(remoteId, merged);
    }
  }

  async function syncAll(): Promise<void> {
    if (disposed) return;
    // Each zone has its own in-flight guard; one hung remote does NOT
    // prevent healthy peers from making progress on subsequent ticks.
    const tasks: Promise<void>[] = [];
    for (const [remoteId, client] of remoteClients.entries()) {
      if (inflight.has(remoteId)) continue;
      inflight.add(remoteId);
      const task = syncZone(remoteId, client).finally(() => {
        inflight.delete(remoteId);
      });
      tasks.push(task);
    }
    if (tasks.length === 0) return;
    await Promise.allSettled(tasks);
  }

  function scheduleNext(): void {
    if (disposed) return;
    timerId = setTimeout(() => {
      if (disposed) return;
      // Arm the NEXT tick from cycle start, not from cycle end. If a
      // hung peer takes the full fetchTimeoutMs, healthy peers will
      // still be polled at their configured cadence. Per-zone in-flight
      // guards (outstandingFetches, inflight) prevent overlap when a
      // tick fires while the prior cycle is still draining.
      scheduleNext();
      syncAll().catch(() => {
        // Sync failures handled per-zone; promise itself swallows residual errors.
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

    getTruncatedCount: (remoteZoneId) => truncatedCounts.get(remoteZoneId) ?? 0,

    getConflictReports: () => [...conflictReports],

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

    onConflict: (handler) => {
      conflictHandlers = new Set([...conflictHandlers, handler]);
      return () => {
        const next = new Set(conflictHandlers);
        next.delete(handler);
        conflictHandlers = next;
      };
    },

    forceResetZone: (remoteZoneId) => {
      const had = outstandingFetches.delete(remoteZoneId);
      if (had) {
        // The original promise can still settle later; if so, its
        // tokenized .finally would normally clear the slot — but the
        // slot may already hold a newer fetch, and the token check
        // there guards against deleting the wrong entry. Resetting
        // health makes the next sync cycle treat this zone as fresh.
        failures.set(remoteZoneId, 0);
        if (statuses.has(remoteZoneId)) statuses.set(remoteZoneId, "active");
      }
      return had;
    },

    [Symbol.asyncDispose]: async () => {
      disposed = true;
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
      handlers = new Set();
      conflictHandlers = new Set();
      cursors.clear();
      eventLogs.clear();
      conflictReports.length = 0;
      failures.clear();
      statuses.clear();

      // Best-effort graceful disconnect — errors are swallowed so dispose() is
      // robust to a hub that's already gone.
      if (hubTransport !== undefined) {
        try {
          await hubTransport.call<void>("federation.zone_disconnect", {
            protocolVersion: FEDERATION_PROTOCOL_VERSION,
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
    a.emittedAt !== b.emittedAt ||
    stableStringify(a.vectorClock ?? {}) !== stableStringify(b.vectorClock ?? {})
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

function isConflictResolutionStrategy(value: unknown): value is ConflictResolutionStrategy {
  return value === "lww" || value === "merge" || value === "manual";
}

function isValidVectorClock(value: unknown): value is Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (component) => Number.isInteger(component) && Number.isFinite(component) && component >= 0,
  );
}

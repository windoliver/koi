/**
 * Background repair worker — spec §6.5 step 4.
 *
 * Each iteration runs two drains in strict order:
 *
 *   1. `drainBlobReadyZero` (spec §6.5 step 4a) — probes every `blob_ready = 0`
 *      row, promotes those whose blob is present, increments `repair_attempts`
 *      (and terminal-deletes once the budget is exhausted) for those whose
 *      blob is definitively absent, and leaves transient failures untouched.
 *
 *   2. `drainPendingBlobDeletes` (spec §6.3 Phase B, shipped in Plan 3) —
 *      claims every unclaimed tombstone, deletes its blob, and reconciles
 *      the tombstone row.
 *
 * Order matters. A terminal-delete in step 1 produces a tombstone that step
 * 2 immediately drains within the SAME iteration — so a one-shot `runOnce()`
 * suffices to fully retire a doomed `blob_ready = 0` row without waiting
 * for the next tick.
 *
 * Lifecycle contract:
 *
 *   - `start()` is idempotent. The first call schedules a `setInterval`
 *     (unless the cadence is `"manual"`); subsequent calls are no-ops so the
 *     close-barrier wiring (Task 6) can safely re-arm without leaking
 *     timers.
 *
 *   - `stop()` clears the interval and waits for any in-flight iteration
 *     before resolving. It is idempotent — concurrent callers share the
 *     same promise. Once stopped, `start()` and `runOnce()` both throw
 *     "worker stopped" so a stale reference cannot re-animate the worker
 *     after close.
 *
 *   - `runOnce()` serializes: if an iteration is already in flight (either
 *     scheduled by the interval or an earlier `runOnce` caller), the second
 *     call awaits the same in-flight promise. This prevents double-execution
 *     of the drain passes, which share a single advisory write path through
 *     the DB — interleaving iterations would cause write conflicts and
 *     wasted blob probes.
 *
 *   - `active()` is `true` strictly while an iteration is running. It flips
 *     back to `false` in the iteration's `finally` block, before the
 *     returned promise resolves.
 *
 * Scheduled iterations must never throw out of the interval callback —
 * `setInterval` does not track promise rejections, so a swallowed throw
 * would silently crash the loop. Every iteration is wrapped in `.catch`
 * with a structured console.warn (Task 7 replaces this with an `onEvent`
 * hook). Manual `runOnce` callers still receive rejections — only the
 * timer path swallows.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import { drainBlobReadyZero } from "./drain-blob-ready-zero.js";
import { createDrainTombstones } from "./drain-tombstones.js";
import type { ArtifactStoreConfig, ArtifactStoreEvent, WorkerStats } from "./types.js";

const DEFAULT_WORKER_INTERVAL_MS = 30_000;

export interface RepairWorkerHandle {
  /**
   * Start the scheduled iteration loop. Idempotent: a second call while the
   * worker is running is a no-op (does NOT create a second interval). Throws
   * "worker stopped" if called after `stop()`.
   */
  readonly start: () => void;
  /**
   * Stop scheduling new iterations and await any in-flight iteration. Safe
   * to call concurrently — all callers share the same drain promise.
   * Idempotent after resolution.
   */
  readonly stop: () => Promise<void>;
  /**
   * Execute a single iteration. Serializes with the interval loop and with
   * other `runOnce` callers — the second caller shares the first caller's
   * in-flight promise. Used by tests and by the close-barrier flush (Task
   * 6) to drain deterministically without waiting for the next tick.
   */
  readonly runOnce: () => Promise<WorkerStats>;
  /** `true` iff an iteration is currently running. */
  readonly active: () => boolean;
}

export interface CreateRepairWorkerArgs {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly config: ArtifactStoreConfig;
  /**
   * Terminal-delete budget for `blob_ready = 0` rows whose blob is
   * definitively absent. Threaded through as a plain number (already
   * validated + defaulted upstream in `create-store.ts`) so the worker
   * doesn't reach back into `ArtifactStoreConfig` for a single field.
   */
  readonly maxRepairAttempts: number;
  /**
   * Structured drift sink. Threaded verbatim into `drainBlobReadyZero`; see
   * `ArtifactStoreConfig.onEvent` for the event contract. A throwing
   * callback is swallowed inside the drain — it never escapes to the
   * scheduled-tick or `runOnce` paths.
   */
  readonly onEvent?: (event: ArtifactStoreEvent) => void;
  /**
   * Test-only iteration hook. Production callers leave this undefined and
   * the default iteration body runs `drainBlobReadyZero` then the Phase B
   * tombstone drain. Tests inject a custom async body to exercise timing /
   * serialization without having to wire up a real Database + BlobStore.
   * Never set this in production callers — the name is deliberately
   * double-underscored for visibility.
   */
  readonly __testIteration?: () => Promise<WorkerStats>;
}

export function createRepairWorker(args: CreateRepairWorkerArgs): RepairWorkerHandle {
  const intervalSetting = args.config.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
  // Phase B drain factory: memoize once per worker so the closure captures
  // `db` + `blobStore` and the iteration body stays a pure function call.
  const drainTombstones = createDrainTombstones({
    db: args.db,
    blobStore: args.blobStore,
  });
  const defaultIterationBody = async (): Promise<WorkerStats> => {
    // Phase A first — spec §6.5 step 4. A terminal-delete here produces a
    // tombstone that Phase B immediately drains in the same iteration.
    const a = await drainBlobReadyZero({
      db: args.db,
      blobStore: args.blobStore,
      maxRepairAttempts: args.maxRepairAttempts,
      // exactOptionalPropertyTypes: only spread when defined, never pass
      // `onEvent: undefined` explicitly.
      ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
    });
    // Phase B second. `drainPendingBlobDeletes` returns `{ reclaimed }`;
    // the WorkerStats field is named `tombstonesDrained` (same concept,
    // plan-level naming). Phase B swallows its own transient blobStore
    // failures (claimed_at stays set for next drain) — those do not
    // surface in WorkerStats. transientErrors reflects Phase A only.
    const b = await drainTombstones();
    return {
      promoted: a.promoted,
      terminallyDeleted: a.terminallyDeleted,
      transientErrors: a.transientErrors,
      tombstonesDrained: b.reclaimed,
      bytesReclaimed: 0,
    };
  };
  const iterationBody: () => Promise<WorkerStats> = args.__testIteration ?? defaultIterationBody;

  // Timer handle from Bun's global setInterval. Stored as `ReturnType<...>`
  // rather than `number` because Bun/Node typings disagree and we only need
  // to pass it back to clearInterval.
  let intervalHandle: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let inFlight: Promise<WorkerStats> | undefined;
  // Memoized stop promise so concurrent callers don't each spawn a drain.
  let stopPromise: Promise<void> | undefined;

  async function runIteration(): Promise<WorkerStats> {
    // Serialize: if an iteration is already in flight, piggy-back on it.
    // This is the "skip if active" behavior from the spec — we return the
    // same WorkerStats the active iteration resolves to, rather than a new
    // stub zeros object, so callers observing concurrent completion see a
    // consistent answer.
    if (inFlight !== undefined) return inFlight;
    const p = (async (): Promise<WorkerStats> => {
      try {
        return await iterationBody();
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = p;
    return p;
  }

  function scheduledTick(): void {
    // Fire-and-forget — the interval can't await. Every rejection must be
    // swallowed here or it'd become an unhandled rejection and crash the
    // process. Task 7 replaces console.warn with the structured onEvent hook.
    runIteration().catch((err: unknown) => {
      console.warn("[@koi/artifacts] repair worker iteration failed", err);
    });
  }

  return {
    start: (): void => {
      if (stopped) throw new Error("worker stopped");
      if (intervalHandle !== undefined) return; // idempotent
      if (intervalSetting === "manual") {
        // Manual mode: no interval. Caller (or test) drives via runOnce.
        // Mark start as having been called by setting a sentinel so
        // subsequent start()s still short-circuit — but a `"manual"` worker
        // has nothing to schedule. We use a no-op interval handle sentinel:
        // a never-firing setInterval could work but leaks a timer; instead
        // we just leave `intervalHandle` undefined and rely on `stopped` to
        // block re-start after stop().
        return;
      }
      intervalHandle = setInterval(scheduledTick, intervalSetting);
    },

    stop: async (): Promise<void> => {
      if (stopPromise !== undefined) return stopPromise;
      stopped = true;
      stopPromise = (async (): Promise<void> => {
        if (intervalHandle !== undefined) {
          clearInterval(intervalHandle);
          intervalHandle = undefined;
        }
        // Await in-flight iteration so close()'s mutation barrier (Task 6)
        // can rely on stop() meaning "no more DB writes from the worker".
        // Ignore the result type — stop callers care about the drain, not
        // the stats.
        if (inFlight !== undefined) {
          try {
            await inFlight;
          } catch {
            // Swallow: a failing final iteration must not prevent stop()
            // from completing. The error was already logged (or thrown to
            // a runOnce caller) upstream.
          }
        }
      })();
      return stopPromise;
    },

    runOnce: async (): Promise<WorkerStats> => {
      if (stopped) throw new Error("worker stopped");
      return runIteration();
    },

    active: (): boolean => inFlight !== undefined,
  };
}

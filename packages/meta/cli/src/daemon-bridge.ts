/**
 * DaemonBridge — subscribes to a `FileSessionRegistry` and dispatches into
 * the TUI store. Registry-only construction mode (Task 6). Task 7 extends
 * this with live/supervisor mode.
 *
 * Cancellation: closed-sentinel pattern from registry-supervisor-bridge.ts.
 * Never calls `iter.return()` — races each `next()` against `closedPromise`.
 */

import type { BackgroundSessionEvent, BackgroundSessionRecord } from "@koi/core/daemon";
import type { FileSessionRegistry } from "@koi/daemon";
import type { BgSessionRow, RegistryStatus, TuiAction } from "@koi/tui";
import { computeFreshness } from "@koi/tui/state";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DaemonBridgeMode = {
  readonly kind: "registry-only";
  readonly registry: FileSessionRegistry;
};

export interface DaemonBridgeToast {
  readonly kind: "info" | "warn" | "error";
  readonly message: string;
}

export interface DaemonBridge {
  readonly close: () => Promise<void>;
}

type Dispatch = (action: TuiAction) => void;

export interface CreateDaemonBridgeOptions {
  readonly mode: DaemonBridgeMode;
  readonly dispatch: Dispatch;
  readonly pushToast: (toast: DaemonBridgeToast) => void;
  readonly clock?: () => number;
  readonly intervals?: { readonly registryPollMs?: number };
  /** Injectable for tests — defaults to global setTimeout. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 1000;
const FAILURE_STRIKE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CEILING_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeBackoff(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CEILING_MS);
}

function recordToRow(
  rec: BackgroundSessionRecord,
  freshness: BgSessionRow["freshness"],
): BgSessionRow {
  return {
    workerId: String(rec.workerId),
    agentId: String(rec.agentId),
    sessionId: rec.sessionId ?? null,
    status: rec.status,
    pid: rec.pid,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt ?? null,
    exitCode: rec.exitCode ?? null,
    lastHeartbeatAt: null,
    heartbeatDeadlineAt: null,
    logPath: rec.logPath,
    backendKind: rec.backendKind,
    version: rec.version ?? 0,
    signaledAt: rec.signaledAt ?? null,
    freshness,
  };
}

function mapRecordsToRows(
  records: readonly BackgroundSessionRecord[],
  now: number,
): readonly BgSessionRow[] {
  return records.map((rec) => {
    const freshness = computeFreshness({
      row: recordToRow(rec, "foreign"), // temporary row for freshness input
      health: null,
      locallySpawnedIds: new Set(),
      now,
    });
    return recordToRow(rec, freshness);
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaemonBridge(opts: CreateDaemonBridgeOptions): DaemonBridge {
  const { mode, dispatch, pushToast, clock = (): number => Date.now(), intervals } = opts;
  const pollMs = intervals?.registryPollMs ?? DEFAULT_POLL_MS;
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;

  const registry = mode.registry;

  // ---------------------------------------------------------------------------
  // Closed sentinel
  // ---------------------------------------------------------------------------
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<"closed">((resolve) => {
    resolveClosed = (): void => resolve("closed");
  });
  let closed = false;

  // ---------------------------------------------------------------------------
  // Mutable bridge state
  // ---------------------------------------------------------------------------
  // Let is required because these values mutate as the bridge runs.
  let consecutiveFailures = 0;
  // undefined = not yet dispatched (first poll always dispatches)
  let registryStatusKind: RegistryStatus["kind"] | undefined;
  let watchDegraded = false;
  let watchDegradedSince = 0;

  // ---------------------------------------------------------------------------
  // Poll helpers
  // ---------------------------------------------------------------------------

  function dispatchRegistryStatus(status: RegistryStatus): void {
    dispatch({ kind: "set_bg_registry_status", status });
  }

  async function runOnePoll(): Promise<void> {
    const result = await registry.describeList();
    if (closed) return;

    if (result.ok) {
      consecutiveFailures = 0;
      const now = clock();
      const rows = mapRecordsToRows(result.value, now);
      dispatch({ kind: "set_bg_rows", rows });

      // If we were stale, recover to live (and possibly degraded if watch is down)
      const wasStale = registryStatusKind === "stale";
      const newStatus: RegistryStatus = watchDegraded
        ? { kind: "degraded", since: watchDegradedSince }
        : { kind: "live" };

      // Always dispatch on first poll (registryStatusKind === undefined),
      // and on transitions thereafter.
      if (registryStatusKind === undefined || registryStatusKind !== newStatus.kind) {
        registryStatusKind = newStatus.kind;
        dispatchRegistryStatus(newStatus);
        if (wasStale) {
          pushToast({ kind: "info", message: "ℹ registry restored" });
        }
      }
    } else {
      consecutiveFailures++;
      if (
        consecutiveFailures >= FAILURE_STRIKE_THRESHOLD &&
        (registryStatusKind === undefined || registryStatusKind !== "stale")
      ) {
        registryStatusKind = "stale";
        dispatchRegistryStatus({
          kind: "stale",
          since: clock(),
          reason: result.error.message,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Poll loop
  // ---------------------------------------------------------------------------

  let pollLoopDone: Promise<void>;

  async function runPollLoop(): Promise<void> {
    while (!closed) {
      await runOnePoll();
      if (closed) break;
      // Sleep for pollMs, but allow close() to interrupt
      await Promise.race([
        new Promise<void>((resolve) => setTimeoutFn(resolve, pollMs)),
        closedPromise,
      ]);
    }
  }

  pollLoopDone = runPollLoop().catch((_e: unknown) => {
    // Poll loop errors are non-fatal; surface via registry status
  });

  // ---------------------------------------------------------------------------
  // Watch loop
  // ---------------------------------------------------------------------------

  let watchLoopDone: Promise<void>;

  async function runWatchLoop(): Promise<void> {
    // eslint-disable-next-line prefer-const
    let attempt = 0;

    while (!closed) {
      const iter = registry.watch()[Symbol.asyncIterator]();
      // pendingNext: one in-flight iter.next() at a time (same pattern as registry-supervisor-bridge.ts)
      let pendingNext: Promise<IteratorResult<BackgroundSessionEvent>> | undefined;

      const getNext = (): Promise<IteratorResult<BackgroundSessionEvent>> => {
        if (pendingNext === undefined) {
          pendingNext = iter.next() as Promise<IteratorResult<BackgroundSessionEvent>>;
        }
        return pendingNext;
      };

      try {
        // Consume events until closed or iter done
        while (!closed) {
          const result = await Promise.race([getNext(), closedPromise]);
          if (result === "closed") return;
          pendingNext = undefined;
          if (result.done) break;

          // Watch event received — trigger immediate poll
          if (!closed) {
            await runOnePoll();
          }

          // Transition back to live if we were degraded
          if (watchDegraded && !closed) {
            watchDegraded = false;
            watchDegradedSince = 0;
            if (registryStatusKind !== "stale") {
              registryStatusKind = "live";
              dispatchRegistryStatus({ kind: "live" });
            }
          }
          attempt = 0;
        }
        // iter.done — no more events; break outer while
        if (!closed) break;
      } catch (_e: unknown) {
        if (closed) return;
        // Watch stream failed → degraded
        if (!watchDegraded) {
          watchDegraded = true;
          watchDegradedSince = clock();
          if (registryStatusKind !== "stale") {
            registryStatusKind = "degraded";
            dispatchRegistryStatus({ kind: "degraded", since: watchDegradedSince });
          }
        }

        // Backoff before reacquire
        const backoffMs = computeBackoff(attempt);
        attempt++;
        await Promise.race([
          new Promise<void>((resolve) => setTimeoutFn(resolve, backoffMs)),
          closedPromise,
        ]);
      }
    }
  }

  watchLoopDone = runWatchLoop().catch((_e: unknown) => {
    // Non-fatal; degraded status already dispatched
  });

  // ---------------------------------------------------------------------------
  // close()
  // ---------------------------------------------------------------------------

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    resolveClosed?.();
    await Promise.all([pollLoopDone, watchLoopDone]);
  };

  return { close };
}

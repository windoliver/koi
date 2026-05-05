/**
 * DaemonBridge — subscribes to a `FileSessionRegistry` and dispatches into
 * the TUI store. Registry-only construction mode (Task 6). Live mode extends
 * this with supervisor health/events + kill flow + locallySpawnedIds (Task 7).
 *
 * Cancellation: closed-sentinel pattern from registry-supervisor-bridge.ts.
 * Never calls `iter.return()` — races each `next()` against `closedPromise`.
 */

import type {
  BackgroundSessionEvent,
  BackgroundSessionRecord,
  Supervisor,
  SupervisorHealth,
  WorkerEvent,
  WorkerId,
} from "@koi/core/daemon";
import type { FileSessionRegistry } from "@koi/daemon";
import type {
  BgSessionRow,
  BridgeStatus,
  RegistryStatus,
  SupervisorEventEntry,
  TuiAction,
} from "@koi/tui";
import { computeFreshness } from "@koi/tui/state";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DaemonBridgeMode =
  | { readonly kind: "registry-only"; readonly registry: FileSessionRegistry }
  | {
      readonly kind: "live";
      readonly registry: FileSessionRegistry;
      readonly supervisor: Supervisor;
    };

export interface DaemonBridgeToast {
  readonly kind: "info" | "warn" | "error";
  readonly message: string;
}

export interface KillRequest {
  readonly workerId: string;
  readonly expectedVersion: number;
  readonly expectedPid: number;
}

export type KillOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "refused"; readonly reason: string };

export interface DaemonBridge {
  readonly close: () => Promise<void>;
  /** Live mode only. Returns refused on registry-only bridges. */
  readonly requestKill: (req: KillRequest) => Promise<KillOutcome>;
  /** Live mode only. No-op in registry-only. */
  readonly markLocallySpawned: (workerId: string) => void;
  /**
   * Live mode only. Removes a previously-marked workerId. Called by the
   * supervisor proxy when start() rejects before admission, so a failed
   * spawn doesn't leave a stale ownership marker that could authorize a
   * kill against a foreign worker reusing the same id later.
   */
  readonly unmarkLocallySpawned: (workerId: string) => void;
}

type Dispatch = (action: TuiAction) => void;

export interface CreateDaemonBridgeOptions {
  readonly mode: DaemonBridgeMode;
  readonly dispatch: Dispatch;
  readonly pushToast: (toast: DaemonBridgeToast) => void;
  readonly clock?: () => number;
  readonly intervals?: {
    readonly registryPollMs?: number;
    readonly healthPollMs?: number;
  };
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
const CRASH_DEDUP_TTL_MS = 30_000;

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
  health: SupervisorHealth | null,
  locallySpawnedIds: ReadonlySet<string>,
): readonly BgSessionRow[] {
  return records.map((rec) => {
    const freshness = computeFreshness({
      row: recordToRow(rec, "foreign"), // temporary row for freshness input
      health,
      locallySpawnedIds,
      now,
    });
    return recordToRow(rec, freshness);
  });
}

function resolveAgentName(workerId: string, health: SupervisorHealth | null): string {
  if (health !== null) {
    const worker = health.workers.find((w) => String(w.workerId) === workerId);
    if (worker !== undefined) return String(worker.agentId);
  }
  return workerId;
}

function inlineFor(event: WorkerEvent, agentName: string): string {
  switch (event.kind) {
    case "started":
      return `↑ ${agentName} started (worker ${String(event.workerId)})`;
    case "exited":
      return `↓ ${agentName} exited (code=${event.code}, state=${event.state})`;
    case "crashed":
      return `✗ ${agentName} crashed: ${event.error.message}`;
    case "heartbeat":
      return ""; // not inlined — too noisy
  }
}

function makeEventEntry(event: WorkerEvent, agentName: string, now: number): SupervisorEventEntry {
  const id = `${String(event.workerId)}:${now}:${event.kind}`;
  switch (event.kind) {
    case "crashed":
      return {
        id,
        ts: event.at,
        kind: event.kind,
        workerId: String(event.workerId),
        agentName,
        detail: event.error.message,
      };
    case "exited":
      return {
        id,
        ts: event.at,
        kind: event.kind,
        workerId: String(event.workerId),
        agentName,
        detail: `code=${event.code}`,
      };
    default:
      return {
        id,
        ts: event.at,
        kind: event.kind,
        workerId: String(event.workerId),
        agentName,
      };
  }
}

interface ChannelLivenessState {
  health: "live" | "stale";
  registryList: "live" | "stale";
  workerEvents: "live" | "stale";
  registryEvents: "live" | "stale";
}

function computeBridgeStatus(channels: ChannelLivenessState, now: number): BridgeStatus {
  if (channels.health === "stale" || channels.registryList === "stale") {
    return {
      kind: "stale",
      since: now,
      reason:
        channels.health === "stale" ? "supervisor health poll failed" : "registry poll failed",
    };
  }
  const missingPush: ("workerEvents" | "registryEvents")[] = [];
  if (channels.workerEvents === "stale") missingPush.push("workerEvents");
  if (channels.registryEvents === "stale") missingPush.push("registryEvents");
  if (missingPush.length > 0) {
    return { kind: "degraded", missing: missingPush, since: now };
  }
  return { kind: "live" };
}

function bridgeStatusKind(status: BridgeStatus): string {
  if (status.kind === "degraded") {
    return `degraded:${(status as { kind: "degraded"; missing: readonly string[] }).missing.join(",")}`;
  }
  return status.kind;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaemonBridge(opts: CreateDaemonBridgeOptions): DaemonBridge {
  const { mode, dispatch, pushToast, clock = (): number => Date.now(), intervals } = opts;
  const pollMs = intervals?.registryPollMs ?? DEFAULT_POLL_MS;
  const healthPollMs = intervals?.healthPollMs ?? DEFAULT_POLL_MS;
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
  // Mutable bridge state (all let because values mutate as bridge runs)
  // ---------------------------------------------------------------------------
  let consecutiveFailures = 0;
  let registryStatusKind: RegistryStatus["kind"] | undefined;
  let watchDegraded = false;
  let watchDegradedSince = 0;

  // Live mode state
  let currentHealth: SupervisorHealth | null = null;
  let prevHealthSnapshot: SupervisorHealth | null = null;
  let consecutiveHealthFailures = 0;
  // Channel liveness for live mode (unused in registry-only)
  const channels: ChannelLivenessState = {
    health: "live",
    registryList: "live",
    workerEvents: "live",
    registryEvents: "live",
  };
  let prevBridgeStatusKey: string | undefined;
  // locallySpawnedIds for live mode
  const locallySpawnedIds = new Set<string>();
  // startedAt per workerId from "started" events (for crash dedup incarnation key)
  const workerStartedAt = new Map<string, number>();
  // Dedup cache: key → expiry ms
  const dedupCache = new Map<string, number>();

  // Single-flight guard for runOnePoll: coalesces concurrent calls so that
  // poll-loop and watch-loop refreshes never publish out-of-order rows.
  let pollInFlight: Promise<void> | null = null;
  // Tracks live async iterators (registry.watch / supervisor.watchAll) so
  // close() can release them — racing iter.next() vs closedPromise leaves
  // them parked otherwise, and a second bridge in the same process would
  // create a second watcher on top of the abandoned one.
  const activeIterators = new Set<AsyncIterator<unknown>>();

  // ---------------------------------------------------------------------------
  // Poll helpers
  // ---------------------------------------------------------------------------

  function dispatchRegistryStatus(status: RegistryStatus): void {
    dispatch({ kind: "set_bg_registry_status", status });
  }

  function dispatchBridgeStatus(): void {
    if (mode.kind !== "live") return;
    const status = computeBridgeStatus(channels, clock());
    const key = bridgeStatusKind(status);
    if (prevBridgeStatusKey === key) return;
    prevBridgeStatusKey = key;
    dispatch({ kind: "set_supervisor_status", status });
  }

  function dedupToast(key: string, now: number): boolean {
    const expiry = dedupCache.get(key);
    if (expiry !== undefined && now < expiry) return true; // already seen
    dedupCache.set(key, now + CRASH_DEDUP_TTL_MS);
    return false;
  }

  async function runOnePoll(): Promise<void> {
    if (pollInFlight !== null) return pollInFlight;
    pollInFlight = runOnePollInner().finally(() => {
      pollInFlight = null;
    });
    return pollInFlight;
  }

  async function runOnePollInner(): Promise<void> {
    const result = await registry.describeList();
    if (closed) return;

    if (result.ok) {
      consecutiveFailures = 0;
      if (mode.kind === "live") {
        channels.registryList = "live";
        dispatchBridgeStatus();
      }
      const now = clock();
      const rows = mapRecordsToRows(result.value, now, currentHealth, locallySpawnedIds);
      dispatch({ kind: "set_bg_rows", rows });

      const wasStale = registryStatusKind === "stale";
      const newStatus: RegistryStatus = watchDegraded
        ? { kind: "degraded", since: watchDegradedSince }
        : { kind: "live" };

      if (registryStatusKind === undefined || registryStatusKind !== newStatus.kind) {
        registryStatusKind = newStatus.kind;
        dispatchRegistryStatus(newStatus);
        if (wasStale) {
          pushToast({ kind: "info", message: "ℹ registry restored" });
        }
      }
    } else {
      consecutiveFailures++;
      if (mode.kind === "live" && consecutiveFailures >= FAILURE_STRIKE_THRESHOLD) {
        channels.registryList = "stale";
        dispatchBridgeStatus();
      }
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
  // Registry poll loop
  // ---------------------------------------------------------------------------

  let pollLoopDone: Promise<void>;

  async function runPollLoop(): Promise<void> {
    while (!closed) {
      await runOnePoll();
      if (closed) break;
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
  // Registry watch loop
  // ---------------------------------------------------------------------------

  let watchLoopDone: Promise<void>;

  async function runWatchLoop(): Promise<void> {
    // let because attempt increments
    let attempt = 0;

    while (!closed) {
      const iter = registry.watch()[Symbol.asyncIterator]();
      activeIterators.add(iter as AsyncIterator<unknown>);
      let pendingNext: Promise<IteratorResult<BackgroundSessionEvent>> | undefined;

      const getNext = (): Promise<IteratorResult<BackgroundSessionEvent>> => {
        if (pendingNext === undefined) {
          pendingNext = iter.next() as Promise<IteratorResult<BackgroundSessionEvent>>;
        }
        return pendingNext;
      };

      try {
        while (!closed) {
          const result = await Promise.race([getNext(), closedPromise]);
          if (result === "closed") return;
          pendingNext = undefined;
          if (result.done) break;

          if (!closed) {
            await runOnePoll();
          }

          if (watchDegraded && !closed) {
            watchDegraded = false;
            watchDegradedSince = 0;
            if (mode.kind === "live") {
              channels.registryEvents = "live";
              dispatchBridgeStatus();
            } else if (registryStatusKind !== "stale") {
              registryStatusKind = "live";
              dispatchRegistryStatus({ kind: "live" });
            }
          }
          attempt = 0;
        }
        if (!closed) break;
      } catch (_e: unknown) {
        if (closed) return;
        if (!watchDegraded) {
          watchDegraded = true;
          watchDegradedSince = clock();
          if (mode.kind === "live") {
            channels.registryEvents = "stale";
            dispatchBridgeStatus();
          } else if (registryStatusKind !== "stale") {
            registryStatusKind = "degraded";
            dispatchRegistryStatus({ kind: "degraded", since: watchDegradedSince });
          }
        }

        const backoffMs = computeBackoff(attempt);
        attempt++;
        await Promise.race([
          new Promise<void>((resolve) => setTimeoutFn(resolve, backoffMs)),
          closedPromise,
        ]);
      } finally {
        activeIterators.delete(iter as AsyncIterator<unknown>);
      }
    }
  }

  watchLoopDone = runWatchLoop().catch((_e: unknown) => {
    // Non-fatal; degraded status already dispatched
  });

  // ---------------------------------------------------------------------------
  // Live mode: health poll loop
  // ---------------------------------------------------------------------------

  let healthLoopDone: Promise<void> = Promise.resolve();

  function diffHealthSnapshots(prev: SupervisorHealth | null, next: SupervisorHealth): void {
    const now = clock();

    // Health status transitions
    if (prev !== null && prev.status === "ok" && next.status !== "ok") {
      const reason = next.reasons[0] ?? "unknown";
      const toastKind = next.status === "degraded" ? "warn" : "warn";
      if (next.status === "degraded") {
        pushToast({ kind: toastKind, message: `⚠ supervisor degraded: ${reason}` });
      } else {
        pushToast({ kind: toastKind, message: `⚠ supervisor unhealthy: ${reason}` });
      }
    }

    // Per-worker state transitions
    for (const worker of next.workers) {
      const workerId = String(worker.workerId);
      const agentName = String(worker.agentId);
      const prevWorker = prev?.workers.find((w) => String(w.workerId) === workerId);
      if (prevWorker === undefined) continue;

      if (prevWorker.state === "running" && worker.state === "quarantined") {
        pushToast({ kind: "warn", message: `⚠ worker ${agentName} quarantined` });
        dispatch({ kind: "add_info", message: `⚠ ${agentName} quarantined (derived)` });
      } else if (prevWorker.state === "running" && worker.state === "restarting") {
        pushToast({ kind: "info", message: `↻ worker ${agentName} restarting` });
        dispatch({ kind: "add_info", message: `↻ ${agentName} restarting (derived)` });
      }
    }

    // Suppress unused variable
    void now;
  }

  async function runHealthPollLoop(): Promise<void> {
    if (mode.kind !== "live") return;
    const { supervisor } = mode;

    while (!closed) {
      try {
        const health = supervisor.health();
        consecutiveHealthFailures = 0;
        if (channels.health === "stale") {
          channels.health = "live";
          dispatchBridgeStatus();
        }

        diffHealthSnapshots(prevHealthSnapshot, health);
        prevHealthSnapshot = health;
        currentHealth = health;
        dispatch({ kind: "set_supervisor_health", health });
      } catch (_e: unknown) {
        consecutiveHealthFailures++;
        if (consecutiveHealthFailures >= FAILURE_STRIKE_THRESHOLD) {
          channels.health = "stale";
          dispatchBridgeStatus();
        }
      }

      if (closed) break;
      await Promise.race([
        new Promise<void>((resolve) => setTimeoutFn(resolve, healthPollMs)),
        closedPromise,
      ]);
    }
  }

  // ---------------------------------------------------------------------------
  // Live mode: watchAll consumer loop
  // ---------------------------------------------------------------------------

  let watchAllLoopDone: Promise<void> = Promise.resolve();
  let watchAllRestoredToastSent = false;

  function processWorkerEvent(event: WorkerEvent): void {
    if (mode.kind !== "live") return;
    const workerId = String(event.workerId);
    const now = clock();
    const agentName = resolveAgentName(workerId, currentHealth);

    // Track startedAt for dedup incarnation key
    if (event.kind === "started") {
      workerStartedAt.set(workerId, event.at);
    }

    // Remove from locallySpawnedIds on terminal events
    if (event.kind === "exited" || event.kind === "crashed") {
      locallySpawnedIds.delete(workerId);
    }

    // Toast for crashes (with incarnation-aware dedup)
    if (event.kind === "crashed") {
      const incarnation = workerStartedAt.get(workerId) ?? event.at;
      const dedupKey = `${workerId}:${incarnation}:crashed`;
      if (!dedupToast(dedupKey, now)) {
        pushToast({
          kind: "warn",
          message: `⚠ worker ${agentName} crashed: ${event.error.message}`,
        });
      }
    }

    const entry = makeEventEntry(event, agentName, now);
    dispatch({ kind: "push_supervisor_event", entry });

    // Inline lifecycle signal in conversation log (heartbeat excluded — too noisy)
    const inlineMsg = inlineFor(event, agentName);
    if (inlineMsg !== "") {
      dispatch({ kind: "add_info", message: inlineMsg });
    }
  }

  async function runWatchAllLoop(): Promise<void> {
    if (mode.kind !== "live") return;
    const { supervisor } = mode;

    // let because attempt increments
    let attempt = 0;

    while (!closed) {
      const iter = supervisor.watchAll()[Symbol.asyncIterator]();
      activeIterators.add(iter as AsyncIterator<unknown>);
      let pendingNext: Promise<IteratorResult<WorkerEvent>> | undefined;

      const getNext = (): Promise<IteratorResult<WorkerEvent>> => {
        if (pendingNext === undefined) {
          pendingNext = iter.next() as Promise<IteratorResult<WorkerEvent>>;
        }
        return pendingNext;
      };

      try {
        while (!closed) {
          const result = await Promise.race([getNext(), closedPromise]);
          if (result === "closed") return;
          pendingNext = undefined;
          if (result.done) break;

          // Successful event — restore if previously stale
          if (channels.workerEvents === "stale" && !closed) {
            channels.workerEvents = "live";
            dispatchBridgeStatus();
            if (!watchAllRestoredToastSent) {
              watchAllRestoredToastSent = true;
              pushToast({ kind: "info", message: "ℹ supervisor events restored" });
            }
          }
          watchAllRestoredToastSent = false; // reset for next stale→live cycle
          attempt = 0;

          processWorkerEvent(result.value);
        }
        if (!closed) break;
      } catch (_e: unknown) {
        if (closed) return;
        // Mark workerEvents stale; clear locallySpawnedIds
        if (channels.workerEvents === "live") {
          channels.workerEvents = "stale";
          // Self-heal: clear locallySpawnedIds when push channel goes stale
          locallySpawnedIds.clear();
          dispatchBridgeStatus();
          watchAllRestoredToastSent = false;
        }

        const backoffMs = computeBackoff(attempt);
        attempt++;
        await Promise.race([
          new Promise<void>((resolve) => setTimeoutFn(resolve, backoffMs)),
          closedPromise,
        ]);
      } finally {
        activeIterators.delete(iter as AsyncIterator<unknown>);
      }
    }
  }

  if (mode.kind === "live") {
    // Dispatch initial attached state
    dispatch({ kind: "set_supervisor_attached", attached: true });
    // Initialize bridge status
    const initialStatus: BridgeStatus = { kind: "live" };
    prevBridgeStatusKey = bridgeStatusKind(initialStatus);
    dispatch({ kind: "set_supervisor_status", status: initialStatus });

    healthLoopDone = runHealthPollLoop().catch((_e: unknown) => {
      // Non-fatal
    });
    watchAllLoopDone = runWatchAllLoop().catch((_e: unknown) => {
      // Non-fatal
    });
  }

  // ---------------------------------------------------------------------------
  // requestKill
  // ---------------------------------------------------------------------------

  async function runKillFlow(req: KillRequest): Promise<KillOutcome> {
    if (mode.kind !== "live") {
      return { kind: "refused", reason: "no live supervisor; use koi bg kill" };
    }
    const { supervisor } = mode;
    const { workerId: reqWorkerId, expectedVersion, expectedPid } = req;

    // Check ownership.
    // Special case: when expectedPid === 0 (starting-row kill) and the
    // workerEvents push channel is stale, locallySpawnedIds may have been
    // cleared as part of self-healing — so the only remaining ownership
    // signal is the registry record. We defer the rejection to the CAS
    // branch below, which validates status === "starting" + version match.
    const healthSnap = supervisor.health();
    const inHealthWorkers = healthSnap.workers.some((w) => String(w.workerId) === reqWorkerId);
    const inLocallySpawned = locallySpawnedIds.has(reqWorkerId);
    const startingRowDegradedFallback = expectedPid === 0 && channels.workerEvents === "stale";
    if (!inHealthWorkers && !inLocallySpawned && !startingRowDegradedFallback) {
      return { kind: "refused", reason: "worker not locally owned" };
    }

    // Describe registry record
    let record: BackgroundSessionRecord | undefined;
    let registryReadable = true;
    try {
      const result = await registry.describe(reqWorkerId as WorkerId);
      if (!result.ok) {
        registryReadable = false;
        pushToast({ kind: "info", message: "ℹ registry unreadable; proceeding with local stop" });
      } else {
        record = result.value;
      }
    } catch (_e: unknown) {
      registryReadable = false;
      pushToast({ kind: "info", message: "ℹ registry unreadable; proceeding with local stop" });
    }

    if (registryReadable && record !== undefined) {
      // Check terminal status
      if (record.status === "exited" || record.status === "crashed") {
        return { kind: "refused", reason: "already terminal" };
      }
      if (record.status === "terminating") {
        return { kind: "refused", reason: "kill in flight; wait" };
      }
      if (record.status === "detached") {
        return { kind: "refused", reason: "use koi bg kill or koi bg attach" };
      }

      // CAS check
      if (expectedPid === 0) {
        // starting-row kill
        if (channels.workerEvents === "live") {
          // bypass CAS — workerEvents live means locallySpawnedIds is authoritative
        } else {
          // workerEvents stale; enforce version CAS
          if (record.status !== "starting" || record.version !== expectedVersion) {
            pushToast({ kind: "warn", message: "⚠ row stale; refresh and try again" });
            return { kind: "refused", reason: "row stale" };
          }
        }
      } else {
        // Normal CAS
        const versionMismatch = record.version !== expectedVersion || record.pid !== expectedPid;
        if (versionMismatch) {
          pushToast({
            kind: "warn",
            message:
              "⚠ row stale; the worker has restarted under a new id — refresh and pick the new row",
          });
          return { kind: "refused", reason: "row stale" };
        }
      }
    }

    // Execute stop
    const stopResult = await supervisor.stop(reqWorkerId as WorkerId, "user-requested");
    if (!stopResult.ok) {
      pushToast({ kind: "warn", message: `⚠ stop failed: ${stopResult.error.message}` });
      return { kind: "refused", reason: stopResult.error.message };
    }
    return { kind: "stopped" };
  }

  // ---------------------------------------------------------------------------
  // close()
  // ---------------------------------------------------------------------------

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    resolveClosed?.();
    // Best-effort release of parked async iterators. We never await the result —
    // races against closedPromise have already unblocked the loops, and some
    // iterators (e.g. registry.watch backed by file events) may not implement
    // return(); throwing or hanging here would block teardown.
    for (const iter of activeIterators) {
      try {
        void iter.return?.(undefined);
      } catch (_e: unknown) {
        // ignore — best-effort cleanup
      }
    }
    activeIterators.clear();
    await Promise.all([pollLoopDone, watchLoopDone, healthLoopDone, watchAllLoopDone]);
  };

  return {
    close,
    requestKill: (req: KillRequest): Promise<KillOutcome> => runKillFlow(req),
    markLocallySpawned: (wId: string): void => {
      if (mode.kind === "live") {
        locallySpawnedIds.add(wId);
      }
    },
    unmarkLocallySpawned: (wId: string): void => {
      if (mode.kind === "live") {
        locallySpawnedIds.delete(wId);
      }
    },
  };
}

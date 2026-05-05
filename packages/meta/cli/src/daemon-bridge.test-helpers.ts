/**
 * Shared fake registry and helper factories for daemon-bridge tests.
 * Not exported from the package — test-only.
 */

import type {
  BackgroundSessionEvent,
  BackgroundSessionRecord,
  BackgroundSessionStatus,
  Supervisor,
  SupervisorHealth,
  WorkerEvent,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core/daemon";
import type { KoiError, Result } from "@koi/core/errors";
import type { FileSessionRegistry } from "@koi/daemon";

// ---------------------------------------------------------------------------
// FakeRegistry
// ---------------------------------------------------------------------------

export interface FakeRegistry extends FileSessionRegistry {
  setRecords(records: readonly BackgroundSessionRecord[]): void;
  setError(error: KoiError | null): void;
  pushWatchEvent(event: BackgroundSessionEvent): void;
  triggerWatchError(err: Error): void;
  /** Incremented on every describeList() call. Test-only inspection. */
  readonly describeListCallCount: () => number;
}

export function makeFakeRegistry(): FakeRegistry {
  // Mutable state for test control
  let records: readonly BackgroundSessionRecord[] = [];
  let currentError: KoiError | null = null;
  const watchListeners: Array<(event: BackgroundSessionEvent | "error", err?: Error) => void> = [];
  let watchErrorPending: Error | undefined;
  let _describeListCallCount = 0;

  const describeList = async (): Promise<Result<readonly BackgroundSessionRecord[], KoiError>> => {
    _describeListCallCount++;
    if (currentError !== null) {
      return { ok: false, error: currentError };
    }
    return { ok: true, value: records };
  };

  async function* watchGen(): AsyncGenerator<BackgroundSessionEvent> {
    // If there's already a pending error, throw immediately
    if (watchErrorPending !== undefined) {
      const err = watchErrorPending;
      watchErrorPending = undefined;
      throw err;
    }
    // Park on a promise that the test can resolve by pushing events/errors
    while (true) {
      const event = await new Promise<BackgroundSessionEvent | "error" | "close">((resolve) => {
        const listener = (e: BackgroundSessionEvent | "error"): void => {
          resolve(e);
        };
        watchListeners.push(listener);
      });
      if (event === "close") return;
      if (event === "error") {
        throw new Error("watch error injected by test");
      }
      yield event;
    }
  }

  const watch = (): AsyncIterable<BackgroundSessionEvent> => ({
    [Symbol.asyncIterator]: () => watchGen(),
  });

  const notImplemented = (): never => {
    throw new Error("not implemented in fake");
  };

  const fake: FakeRegistry = {
    describeList,
    watch,
    // Satisfy the full BackgroundSessionRegistry + FileSessionRegistry interface:
    register: () => notImplemented(),
    update: () => notImplemented(),
    unregister: () => notImplemented(),
    get: () => notImplemented(),
    list: () => notImplemented(),
    describe: () => notImplemented(),
    // Test control methods
    setRecords(newRecords: readonly BackgroundSessionRecord[]): void {
      records = newRecords;
    },
    setError(error: KoiError | null): void {
      currentError = error;
    },
    pushWatchEvent(event: BackgroundSessionEvent): void {
      const listener = watchListeners.shift();
      if (listener !== undefined) {
        listener(event);
      }
    },
    describeListCallCount: () => _describeListCallCount,
    triggerWatchError(_err: Error): void {
      // Signal the next waiting listener as "error"
      const listener = watchListeners.shift();
      if (listener !== undefined) {
        listener("error");
      } else {
        // Store for the next watch() call
        watchErrorPending = _err;
      }
    },
  };

  return fake;
}

// ---------------------------------------------------------------------------
// FakeSupervisor
// ---------------------------------------------------------------------------

export interface FakeSupervisor extends Supervisor {
  /** Replace the in-memory health snapshot returned by health(). */
  setHealth(h: SupervisorHealth): void;
  /** Push a WorkerEvent to all active watchAll() consumers. */
  pushWorkerEvent(event: WorkerEvent): void;
  /** Cause the next watchAll() consumer to throw on its next next(). */
  triggerWatchAllError(err: Error): void;
  /** Inspect stop() call history. */
  readonly stopCalls: () => ReadonlyArray<{ id: string; reason: string }>;
  /** Override stop() return value for next call. */
  setStopResult(result: Result<void, KoiError>): void;
}

export function makeFakeSupervisor(initialHealth?: SupervisorHealth): FakeSupervisor {
  let _health: SupervisorHealth = initialHealth ?? {
    status: "ok",
    reasons: [],
    metrics: {
      poolSize: 0,
      maxWorkers: 10,
      quarantinedCount: 0,
      restartingCount: 0,
      pendingSpawnCount: 0,
      eventDropCount: 0,
      shuttingDown: false,
    },
    workers: [],
  };

  const watchAllListeners: Array<(event: WorkerEvent | "error" | "close") => void> = [];
  let watchAllErrorPending: Error | undefined;
  const _stopCalls: Array<{ id: string; reason: string }> = [];
  let nextStopResult: Result<void, KoiError> = { ok: true, value: undefined };

  async function* watchAllGen(): AsyncGenerator<WorkerEvent> {
    if (watchAllErrorPending !== undefined) {
      const err = watchAllErrorPending;
      watchAllErrorPending = undefined;
      throw err;
    }
    while (true) {
      const event = await new Promise<WorkerEvent | "error" | "close">((resolve) => {
        const listener = (e: WorkerEvent | "error" | "close"): void => {
          resolve(e);
        };
        watchAllListeners.push(listener);
      });
      if (event === "close") return;
      if (event === "error") {
        throw new Error("watchAll error injected by test");
      }
      yield event;
    }
  }

  const notImplemented = (): never => {
    throw new Error("not implemented in FakeSupervisor");
  };

  return {
    health: (): SupervisorHealth => _health,
    watchAll: (): AsyncIterable<WorkerEvent> => ({
      [Symbol.asyncIterator]: () => watchAllGen(),
    }),
    stop: async (id: WorkerId, reason: string): Promise<Result<void, KoiError>> => {
      _stopCalls.push({ id: String(id), reason });
      const result = nextStopResult;
      nextStopResult = { ok: true, value: undefined }; // reset for next call
      return result;
    },
    start: (_req: WorkerSpawnRequest): Promise<never> => notImplemented(),
    shutdown: (_reason: string): Promise<never> => notImplemented(),
    list: () => [],
    setHealth(h: SupervisorHealth): void {
      _health = h;
    },
    pushWorkerEvent(event: WorkerEvent): void {
      const listener = watchAllListeners.shift();
      if (listener !== undefined) {
        listener(event);
      }
    },
    triggerWatchAllError(err: Error): void {
      const listener = watchAllListeners.shift();
      if (listener !== undefined) {
        listener("error");
      } else {
        watchAllErrorPending = err;
      }
    },
    stopCalls: () => _stopCalls,
    setStopResult(result: Result<void, KoiError>): void {
      nextStopResult = result;
    },
  };
}

// ---------------------------------------------------------------------------
// Record factory
// ---------------------------------------------------------------------------

let workerSeq = 0;

export function makeRecord(
  workerId: string,
  agentId: string,
  status: BackgroundSessionStatus = "running",
): BackgroundSessionRecord {
  workerSeq++;
  return {
    workerId: workerId as WorkerId,
    agentId: agentId as never,
    sessionId: undefined,
    pid: 1000 + workerSeq,
    status,
    startedAt: 1_000_000,
    endedAt: undefined,
    exitCode: undefined,
    logPath: `/tmp/${workerId}.log`,
    command: ["koi", "start"],
    backendKind: "subprocess",
    version: 1,
    signaledAt: undefined,
  };
}

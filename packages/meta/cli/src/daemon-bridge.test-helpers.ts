/**
 * Shared fake registry and helper factories for daemon-bridge tests.
 * Not exported from the package — test-only.
 */

import type {
  BackgroundSessionEvent,
  BackgroundSessionRecord,
  BackgroundSessionStatus,
  WorkerId,
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

/**
 * Bridges a live `Supervisor` into a `BackgroundSessionRegistry`: subscribes
 * to `supervisor.watchAll()` and mirrors every lifecycle event into registry
 * writes. The registry becomes the cross-process source of truth, while the
 * supervisor remains authoritative for in-process pool state.
 *
 * Policy:
 *   - `started`   → `status: "running"`
 *   - `exited`    → `status: "exited"`, endedAt, exitCode
 *   - `crashed`   → `status: "crashed"`, endedAt
 *   - `heartbeat` → no-op (3b-3 will populate heartbeat timestamps)
 *
 * Ownership: callers must `register()` a `BackgroundSessionRecord` BEFORE
 * `supervisor.start()` — the bridge only updates existing records. This keeps
 * the bridge stateless about command/logPath/pid which the registrar knows
 * at spawn time but the watcher does not.
 */

import type {
  BackgroundSessionRegistry,
  BackgroundSessionStatus,
  KoiError,
  Supervisor,
  WorkerEvent,
  WorkerId,
} from "@koi/core";

export interface RegistryBridge {
  /** Stop the bridge and release the underlying watchAll iterator. */
  readonly close: () => Promise<void>;
  /** Resolves after the internal watch loop has fully drained. */
  readonly done: Promise<void>;
  /** Reports the last non-fatal error observed during event processing. */
  readonly lastError: () => KoiError | undefined;
}

export interface AttachRegistryConfig {
  readonly supervisor: Supervisor;
  readonly registry: BackgroundSessionRegistry;
  /**
   * Optional hook called on every registry-update failure. Defaults to a
   * no-op. The bridge never throws — errors are surfaced via the callback
   * and `lastError()`.
   */
  readonly onError?: (error: KoiError, event: WorkerEvent) => void;
  /**
   * How long `close()` will keep draining already-buffered events from
   * `supervisor.watchAll()` before giving up and resolving. Defaults to
   * 2000 ms — long enough for a well-behaved registry to absorb the
   * final `exited`/`crashed` bursts that a shutdown produces, short
   * enough that a wedged registry cannot hold teardown forever.
   */
  readonly drainTimeoutMs?: number;
}

export function attachRegistry(config: AttachRegistryConfig): RegistryBridge {
  const { supervisor, registry, onError } = config;
  const drainTimeoutMs = config.drainTimeoutMs ?? 2000;
  let lastErr: KoiError | undefined;
  let closing = false;
  // Absolute deadline set when close() is called. The drain loop keeps
  // consuming events until this deadline, not until the first idle tick —
  // otherwise a brief gap between supervisor.shutdown() and its last
  // terminal event would cause the bridge to abandon the event mid-flight
  // and leave sessions stuck in non-terminal status.
  let drainDeadline = 0;

  const handle = async (event: WorkerEvent): Promise<void> => {
    const mapped = mapEvent(event);
    if (mapped === undefined) return;
    let { status } = mapped;
    const { id, endedAt, exitCode, pid, startedAt, clearTerminal } = mapped;
    // Bridge-layer operator-intent correction. The subprocess backend
    // classifies any non-zero exit it didn't initiate itself as
    // `crashed` — which is correct from the supervisor's POV but
    // wrong when an off-path killer (`koi bg kill` in another
    // process) triggered the exit. The CLI marks its intent by
    // CAS-writing `status: "terminating"` before it signals; if we
    // see `crashed` for a record currently in that state, treat it
    // as the expected end of an operator-initiated termination and
    // record `exited` instead. Eventually-consistent only: a bridge
    // that hasn't observed the CLI's claim yet still writes `crashed`,
    // which is the conservative fallback.
    if (event.kind === "crashed") {
      const current = await registry.get(id);
      if (current?.status === "terminating") status = "exited";
    }
    const result = await registry.update(id, {
      status,
      ...(endedAt !== undefined && { endedAt }),
      ...(exitCode !== undefined && { exitCode }),
      ...(pid !== undefined && { pid }),
      ...(startedAt !== undefined && { startedAt }),
      ...(clearTerminal === true && { clearTerminal: true }),
    });
    if (!result.ok) {
      lastErr = result.error;
      if (onError !== undefined) onError(result.error, event);
    }
  };

  // `supervisor.watchAll()` is an infinite async generator that doesn't
  // terminate on supervisor shutdown: its loop parks on a waker promise,
  // and calling `iter.return()` while parked can't unblock the pending
  // await. So the bridge races each `next()` against a `closed` sentinel
  // — when `close()` resolves the sentinel, the loop exits without waiting
  // for another event to arrive.
  const iterator = supervisor.watchAll()[Symbol.asyncIterator]();
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<"closed">((resolve) => {
    resolveClosed = () => resolve("closed");
  });

  // Exactly one in-flight iterator.next() at any time. Calling next()
  // again before the previous promise settles would queue a second
  // request behind the first — the first then resolves a real event but
  // nobody is awaiting it, silently dropping the lifecycle update. We
  // thread the same pending promise across all iterations (including the
  // close() mode transition) so every event reaches handle().
  let pendingNext: Promise<IteratorResult<WorkerEvent>> | undefined;
  const getNext = (): Promise<IteratorResult<WorkerEvent>> => {
    if (pendingNext === undefined) pendingNext = iterator.next();
    return pendingNext;
  };
  const consumeNext = (): void => {
    pendingNext = undefined;
  };

  const loop = async (): Promise<void> => {
    while (true) {
      // During close() we stay in drain mode until the absolute deadline
      // set by close(). A single "idle tick" is not enough: supervisor
      // shutdown publishes its final exited/crashed events with tiny
      // inter-event gaps, and exiting on the first idle would silently
      // drop the final lifecycle updates. Instead, race each next()
      // against the remaining time in the drain window; only exit when
      // (a) the deadline passes, (b) the iterator says it's done, or
      // (c) the iterator throws.
      if (closing) {
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutP = new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), remaining);
        });
        const race = await Promise.race([getNext(), timeoutP]);
        if (timer !== undefined) clearTimeout(timer);
        if (race === "deadline") return;
        // Race was won by getNext(); the pending promise has resolved.
        consumeNext();
        if (race.done) return;
        await handle(race.value);
        continue;
      }
      const result = await Promise.race([getNext(), closed]);
      if (result === "closed") {
        // Entered drain mode; DO NOT consumeNext() — the pending promise
        // from the race is still live, and drain mode must be the one
        // that awaits it. Otherwise the first post-close event ends up
        // resolving a dropped promise and never reaches the registry.
        closing = true;
        continue;
      }
      consumeNext();
      if (result.done) return;
      await handle(result.value);
    }
  };

  const done = loop().catch((e: unknown) => {
    const err: KoiError = {
      code: "INTERNAL",
      message: `registry bridge terminated: ${e instanceof Error ? e.message : String(e)}`,
      retryable: false,
    };
    lastErr = err;
  });

  const close = async (): Promise<void> => {
    // Publish the absolute drain deadline BEFORE flipping the sentinel so
    // the drain branch in loop() has a valid timestamp the first time it
    // checks. (Promise resolution is async; the loop wakes on the next
    // microtask with drainDeadline already set.)
    drainDeadline = Date.now() + drainTimeoutMs;
    resolveClosed?.();
    // Bounded wait: if the drain loop wedges (e.g., registry.update is
    // hung on a slow filesystem), close() must not block forever.
    // After a small grace beyond the drain window we give up and let
    // the caller finish shutdown; residual events surface via lastError.
    const hardTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), drainTimeoutMs + 500),
    );
    const outcome = await Promise.race([done.then(() => "drained" as const), hardTimeout]);
    if (outcome === "timeout") {
      lastErr = {
        code: "TIMEOUT",
        message: `registry bridge drain exceeded ${drainTimeoutMs}ms; residual events may be lost`,
        retryable: false,
      };
    }
    // Intentionally don't await iterator.return(): supervisor.watchAll is
    // parked on a waker promise that only resolves when the supervisor
    // publishes the next event, so `return()` would never settle. The
    // supervisor will clean up its waker entry when it shuts down, and
    // the generator will be GC'd once we drop the last reference.
    void iterator.return?.().catch(() => {});
  };

  return {
    close,
    done,
    lastError: () => lastErr,
  };
}

interface MappedEvent {
  readonly id: WorkerId;
  readonly status: BackgroundSessionStatus;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly clearTerminal?: boolean;
}

function mapEvent(event: WorkerEvent): MappedEvent | undefined {
  switch (event.kind) {
    case "started":
      // Refresh pid + startedAt on every start (including restarts). The
      // supervisor's restart policy respawns under the same workerId but
      // with a fresh OS process — without this, the registry's pid field
      // would keep pointing at the pre-restart PID and off-path killers
      // (e.g. `koi bg kill` in another process) would signal a reused or
      // unrelated PID. Backends that lack a PID (in-process) omit the
      // field; we leave the registry's previous value in place.
      //
      // `clearTerminal: true` drops any endedAt/exitCode the previous
      // exit left behind so a restarted "running" worker doesn't carry
      // misleading terminal metadata (e.g. status=running + exitCode=137).
      return {
        id: event.workerId,
        status: "running",
        startedAt: event.at,
        clearTerminal: true,
        ...(event.pid !== undefined && { pid: event.pid }),
      };
    case "exited":
      return {
        id: event.workerId,
        status: "exited",
        endedAt: event.at,
        exitCode: event.code,
      };
    case "crashed":
      return { id: event.workerId, status: "crashed", endedAt: event.at };
    case "heartbeat":
      return undefined;
  }
}

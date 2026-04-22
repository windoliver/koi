import { closeSync, openSync } from "node:fs";
import type {
  KoiError,
  Result,
  WorkerBackend,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core";
import { isHeartbeatOptIn } from "./heartbeat-opt-in.js";

interface SubprocState {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly controller: AbortController;
  readonly events: WorkerEvent[];
  readonly listeners: Array<(ev: WorkerEvent) => void>;
  alive: boolean;
  // Set when the terminal event has been delivered through a watch()
  // generator OR when the fallback grace period expires — whichever wins.
  terminalDelivered: boolean;
  // Set to true when terminate()/kill() is called on this worker. Exit
  // events for intentionally-terminated processes are classified as
  // `exited` (not `crashed`) even for non-zero exit codes like 143
  // (SIGTERM) or 137 (SIGKILL), since the caller asked for termination.
  terminatedIntentionally: boolean;
  // Last-resort prune timer, armed on terminal exit. If no watcher attaches
  // within the grace window, we delete the entry so a caller who never
  // watches cannot leak state for the daemon's lifetime.
  pruneTimer: ReturnType<typeof setTimeout> | undefined;
  // Most recent heartbeat — replayed to each attaching watcher so the
  // supervisor's fire-and-forget watch IIFE isn't racing against the
  // child's first IPC send. Without this, a heartbeat that fires in the
  // ~microsecond window between spawn and watch-loop attach is dropped
  // (no listener yet), and the supervisor's deadline timer arms with no
  // observe() — a healthy worker can hit HEARTBEAT_TIMEOUT. Bounded to
  // exactly one event per worker (latest wins), so no unbounded growth.
  lastHeartbeat: WorkerEvent | undefined;
}

// How long we retain a dead worker's state after exit if no watcher has
// consumed the terminal event yet. Short enough that stragglers don't
// accumulate, long enough that the supervisor's fire-and-forget watch
// IIFE (which runs on the microtask after spawn resolves) always attaches
// in time.
const PRUNE_GRACE_MS = 30_000;

export function createSubprocessBackend(): WorkerBackend {
  const workers = new Map<WorkerId, SubprocState>();

  const emit = (state: SubprocState, ev: WorkerEvent): void => {
    // Heartbeat events are liveness signals, not lifecycle history — a
    // long-lived worker emits them every few seconds, so retaining all
    // of them in the replay buffer grows state.events unboundedly.
    //
    // Strategy: lifecycle events (started, exited, crashed) stay in the
    // replay buffer. Heartbeats replace state.lastHeartbeat (one-slot
    // latest-wins) so a late-attaching watcher sees the most recent
    // liveness signal instead of missing it entirely.
    if (ev.kind === "heartbeat") {
      state.lastHeartbeat = ev;
    } else {
      state.events.push(ev);
    }
    const pending = [...state.listeners];
    state.listeners.length = 0;
    for (const l of pending) l(ev);
  };

  const spawn = async (request: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
    if (request.command.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "WorkerSpawnRequest.command must be non-empty",
          retryable: false,
        },
      };
    }

    // Build env using filter form — no `as` cast, strict-safe.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (request.env !== undefined) {
      for (const [k, v] of Object.entries(request.env)) {
        if (v === null) {
          delete env[k];
        } else {
          env[k] = v;
        }
      }
    }

    // Stdio defaults are security- and correctness-conservative:
    //   stdin: "ignore"  — workers do NOT inherit the supervisor's TTY.
    //     A shared TTY would let any worker consume operator keystrokes
    //     intended for the CLI/TUI and let a malicious child interfere
    //     with interactive control. Opt-in stdio modes are a follow-up.
    //   stdout/stderr: "ignore" by default — pipes would fill OS buffers
    //     for chatty workers and deadlock them. When `backendHints.logPath`
    //     is set, both streams share a single O_APPEND fd so stdout and
    //     stderr interleave in arrival order without clobbering each other.
    //     Bun.file() per-stream would truncate in both directions.
    const logPath = resolveLogPath(request);
    let logFd: number | undefined;
    if (logPath !== undefined) {
      try {
        // Mode 0600: worker stdout/stderr may contain secrets, tokens, or
        // PII. Default umask (022) would make new logs world-readable —
        // unacceptable on shared hosts.
        logFd = openSync(logPath, "a", 0o600);
      } catch (e) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Failed to open log file ${logPath}: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
          },
        };
      }
    }
    try {
      // Forward-declare `state` so the IPC handler can close over it safely.
      // The handler is attached at spawn time, but `state` is only assigned
      // after `Bun.spawn` returns — the guard `state === undefined` prevents
      // any early IPC message from dereferencing an uninitialized value.
      // `let` is intentional here: the forward-reference pattern requires it.
      let state: SubprocState | undefined;
      const ipcHandler = (message: unknown): void => {
        if (state === undefined) return;
        if (!isHeartbeatMessage(message)) return;
        emit(state, {
          kind: "heartbeat",
          workerId: request.workerId,
          at: Date.now(),
        });
      };

      const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
        env,
        stdin: "ignore",
        stdout: logFd ?? "ignore",
        stderr: logFd ?? "ignore",
      };
      if (request.cwd !== undefined) {
        spawnOptions.cwd = request.cwd;
      }
      if (isHeartbeatOptIn(request)) {
        spawnOptions.ipc = ipcHandler;
      }
      const proc = Bun.spawn([...request.command], spawnOptions);
      // The subprocess inherits the fd; the parent can drop its handle.
      // The OS keeps the fd open for the child until it exits.
      if (logFd !== undefined) {
        try {
          closeSync(logFd);
        } catch {
          // Best-effort — the child still has its dup of the fd.
        }
        logFd = undefined;
      }

      const controller = new AbortController();
      state = {
        proc,
        controller,
        events: [],
        listeners: [],
        alive: true,
        terminalDelivered: false,
        terminatedIntentionally: false,
        pruneTimer: undefined,
        lastHeartbeat: undefined,
      };
      workers.set(request.workerId, state);
      // Include pid so registry bridges can refresh the record's process
      // identity on every respawn — without it, a restart leaves the
      // registry pointing at the pre-restart PID.
      emit(state, {
        kind: "started",
        workerId: request.workerId,
        at: Date.now(),
        pid: proc.pid,
      });

      void proc.exited.then((code) => {
        state.alive = false;
        controller.abort();
        // Intentional termination (via terminate/kill) is always an `exited`
        // event even for non-zero exit codes (143 SIGTERM, 137 SIGKILL),
        // because the caller explicitly asked for the process to stop.
        // Only unsolicited non-zero exits are classified as crashes.
        const ev: WorkerEvent =
          code === 0 || state.terminatedIntentionally
            ? {
                kind: "exited",
                workerId: request.workerId,
                at: Date.now(),
                code,
                state: "terminated",
              }
            : {
                kind: "crashed",
                workerId: request.workerId,
                at: Date.now(),
                error: {
                  code: "INTERNAL",
                  message: `subprocess exited with code ${code}`,
                  retryable: true,
                },
              };
        emit(state, ev);
        // DO NOT delete from `workers` yet. A fast-exiting subprocess can
        // reach this callback before the supervisor's fire-and-forget watch
        // loop has attached its listener — deleting here would lose the
        // started+exited events. Instead:
        //   - watch() will prune once it yields the terminal event
        //   - a fallback timer prunes if no watcher ever attaches
        state.pruneTimer = setTimeout(() => {
          // Identity-check before deleting: if the supervisor aborted the
          // watch before the terminal event was drained (terminalDelivered
          // stays false) and a same-id respawn has already installed a
          // fresh `state` into `workers`, an indiscriminate delete would
          // evict the LIVE successor entry and lose track of a running
          // process. Only delete if `workers.get(id)` is still this exact
          // (stale) state reference.
          if (!state.terminalDelivered && workers.get(request.workerId) === state) {
            workers.delete(request.workerId);
          }
        }, PRUNE_GRACE_MS);
      });

      const handle: WorkerHandle = {
        workerId: request.workerId,
        agentId: request.agentId,
        backendKind: "subprocess",
        startedAt: Date.now(),
        signal: controller.signal,
      };
      return { ok: true, value: handle };
    } catch (e) {
      // Bun.spawn threw before the child inherited the fd — close it ourselves.
      if (logFd !== undefined) {
        try {
          closeSync(logFd);
        } catch {
          /* best-effort */
        }
      }
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to spawn subprocess: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
        },
      };
    }
  };

  const terminate = async (id: WorkerId, _reason: string): Promise<Result<void, KoiError>> => {
    const state = workers.get(id);
    if (state === undefined) return { ok: true, value: undefined };
    state.terminatedIntentionally = true;
    state.proc.kill("SIGTERM");
    return { ok: true, value: undefined };
  };

  const kill = async (id: WorkerId): Promise<Result<void, KoiError>> => {
    const state = workers.get(id);
    if (state === undefined) return { ok: true, value: undefined };
    state.terminatedIntentionally = true;
    state.proc.kill("SIGKILL");
    return { ok: true, value: undefined };
  };

  const isAlive = async (id: WorkerId): Promise<boolean> => {
    return workers.get(id)?.alive ?? false;
  };

  const watch = async function* (id: WorkerId, signal?: AbortSignal): AsyncIterable<WorkerEvent> {
    const state = workers.get(id);
    if (state === undefined) return;
    // Early-abort short-circuit: caller aborted before we even started.
    if (signal?.aborted) return;
    // Cancellation wiring: iterator.return() (called by test helpers or
    // the supervisor during shutdown) must unblock a parked await even
    // when no backend events are arriving. The pattern: remember the
    // current resolver and resolve it with a cancellation sentinel in
    // the finally block. Without this, a stalled iterator could hang
    // indefinitely on its next() promise while waiting for cancellation.
    let cancelResolve: (() => void) | undefined;
    // AbortSignal plumbing: supervisor aborts on stop()/shutdown() so a
    // parked await exits even when the backend never emits a terminal
    // event (pathological adapters or backends under stress). We attach
    // one listener that resolves the currently-parked cancelResolve.
    // Removed in finally.
    const onAbort = (): void => {
      if (cancelResolve !== undefined) {
        const r = cancelResolve;
        cancelResolve = undefined;
        r();
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // We track our position in state.events explicitly (not via for..of)
      // because we need to re-drain after yielding the lastHeartbeat
      // replay. A terminal event appended during that yield pause must
      // still be delivered before we fall through to the alive check.
      let cursor = 0;
      const drainLifecycle = function* (): Generator<WorkerEvent, boolean> {
        // Returns true if a terminal event was yielded (caller should stop).
        while (cursor < state.events.length) {
          const ev = state.events[cursor++];
          if (ev === undefined) break;
          yield ev;
          if (ev.kind === "exited" || ev.kind === "crashed") return true;
        }
        return false;
      };
      // Phase 1: drain existing lifecycle events (started + possibly terminal).
      {
        let terminated = false;
        for (const ev of drainLifecycle()) {
          yield ev;
          if (ev.kind === "exited" || ev.kind === "crashed") {
            terminated = true;
            break;
          }
        }
        if (terminated) {
          state.terminalDelivered = true;
          return;
        }
      }
      // Phase 2: replay the most recent heartbeat so a watcher attaching
      // after the child's first process.send() still observes liveness.
      // Without this, the supervisor's deadline timer can arm just as a
      // fresh heartbeat was being dropped, leading to spurious HEARTBEAT_TIMEOUT.
      if (state.lastHeartbeat !== undefined) {
        yield state.lastHeartbeat;
      }
      // Phase 3: re-drain — a terminal event may have been pushed while
      // we were yielding the heartbeat (consumer-side await pauses us).
      {
        let terminated = false;
        for (const ev of drainLifecycle()) {
          yield ev;
          if (ev.kind === "exited" || ev.kind === "crashed") {
            terminated = true;
            break;
          }
        }
        if (terminated) {
          state.terminalDelivered = true;
          return;
        }
      }
      // Phase 4: always-drain-then-await loop. Unifying the drain and
      // await into a single loop eliminates the heartbeat-then-exit race
      // where an `exited`/`crashed` event appended to state.events during
      // a yield pause is never delivered (listeners had already been
      // drained, state.alive flips false, and a naive `while(alive)` exit
      // leaves the terminal event buffered but unseen).
      while (true) {
        if (signal?.aborted) return;
        // Drain any events appended since the last iteration (including
        // during the yield pause of whatever we just yielded).
        while (cursor < state.events.length) {
          const ev = state.events[cursor++];
          if (ev === undefined) break;
          yield ev;
          if (ev.kind === "exited" || ev.kind === "crashed") {
            state.terminalDelivered = true;
            return;
          }
        }
        if (!state.alive) {
          // Process died and no pending terminal is buffered: mark delivered
          // and return. The fallback-prune path cleans up orphaned state.
          state.terminalDelivered = true;
          return;
        }
        // Wait for next event or cancellation. Non-heartbeat events are
        // also appended to state.events (via emit), so we advance the
        // cursor after yield to avoid double-delivery on the next drain.
        let eventListener: ((ev: WorkerEvent) => void) | undefined;
        const result = await new Promise<
          { readonly kind: "event"; readonly ev: WorkerEvent } | { readonly kind: "cancel" }
        >((resolve) => {
          eventListener = (ev: WorkerEvent): void => resolve({ kind: "event", ev });
          state.listeners.push(eventListener);
          cancelResolve = (): void => resolve({ kind: "cancel" });
        });
        cancelResolve = undefined;
        // Remove our listener if cancellation won — otherwise the next
        // emit would hit a dead resolver (harmless but leaky).
        if (eventListener !== undefined) {
          const idx = state.listeners.indexOf(eventListener);
          if (idx !== -1) state.listeners.splice(idx, 1);
        }
        if (result.kind === "cancel") return;
        const ev = result.ev;
        yield ev;
        if (ev.kind !== "heartbeat") cursor++;
        if (ev.kind === "exited" || ev.kind === "crashed") {
          state.terminalDelivered = true;
          return;
        }
      }
    } finally {
      // Detach abort listener so the AbortSignal doesn't retain this
      // closure past the generator's lifetime.
      signal?.removeEventListener("abort", onAbort);
      // Wake any parked Promise so iterator.return() can complete
      // bounded. Without this, a consumer timing out and calling return
      // would hang on a Promise that only resolves via a new event.
      if (cancelResolve !== undefined) {
        const r = cancelResolve;
        cancelResolve = undefined;
        r();
      }
      // Prune the worker state once a watcher has drained it. The
      // fallback prune timer set in proc.exited.then is cleared here so
      // we don't double-delete or prune after a legitimate consumer.
      //
      // BUT: only clear the fallback timer when terminal was actually
      // delivered. If abort fired between proc.exited and terminal drain
      // (terminalDelivered stays false), clearing the timer would strand
      // the dead state in `workers` forever — no later code path prunes
      // it, since the watcher has already exited. Leaving the timer
      // armed means the fallback prunes the entry after PRUNE_GRACE_MS,
      // identity-checked against `workers.get(id) === state`.
      if (state.terminalDelivered && state.pruneTimer !== undefined) {
        clearTimeout(state.pruneTimer);
        state.pruneTimer = undefined;
      }
      // Identity-check: a same-id respawn may have replaced `workers[id]`
      // with a fresh state between terminal delivery and this finally
      // hook running. Deleting unconditionally would evict the live
      // successor. Only remove when the map still points at the stale
      // state we were watching.
      if (state.terminalDelivered && workers.get(id) === state) {
        workers.delete(id);
      }
    }
  };

  return {
    kind: "subprocess",
    displayName: "Bun subprocess",
    isAvailable: () => typeof Bun !== "undefined" && typeof Bun.spawn === "function",
    supportsHeartbeat: true,
    spawn,
    terminate,
    kill,
    isAlive,
    watch,
  };
}

/**
 * Extract the log path from `backendHints.logPath`. Returns the string if
 * present and non-empty, otherwise undefined (falls back to /dev/null stdio).
 */
function resolveLogPath(request: WorkerSpawnRequest): string | undefined {
  const hints = request.backendHints;
  if (hints === undefined) return undefined;
  const value = hints.logPath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Type guard for Bun IPC heartbeat messages sent by child processes via
 * `process.send({ koi: "heartbeat" })`. Uses `in` narrowing — no `as` cast.
 * After `"koi" in message`, TypeScript narrows `message` to
 * `object & { koi: unknown }`, making `.koi` accessible without a cast.
 */
function isHeartbeatMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  if (!("koi" in message)) return false;
  return message.koi === "heartbeat";
}

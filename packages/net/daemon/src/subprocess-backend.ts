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
    state.events.push(ev);
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
      const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
        env,
        stdin: "ignore",
        stdout: logFd ?? "ignore",
        stderr: logFd ?? "ignore",
      };
      if (request.cwd !== undefined) {
        spawnOptions.cwd = request.cwd;
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
      const state: SubprocState = {
        proc,
        controller,
        events: [],
        listeners: [],
        alive: true,
        terminalDelivered: false,
        terminatedIntentionally: false,
        pruneTimer: undefined,
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
          if (!state.terminalDelivered) workers.delete(request.workerId);
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

  const watch = async function* (id: WorkerId): AsyncIterable<WorkerEvent> {
    const state = workers.get(id);
    if (state === undefined) return;
    try {
      // Yield buffered events first (includes started, and possibly a
      // terminal event if the subprocess exited before watch attached).
      for (const ev of state.events) {
        yield ev;
        if (ev.kind === "exited" || ev.kind === "crashed") {
          state.terminalDelivered = true;
          return;
        }
      }
      if (!state.alive) {
        state.terminalDelivered = true;
        return;
      }
      while (state.alive) {
        const ev = await new Promise<WorkerEvent>((resolve) => {
          state.listeners.push(resolve);
        });
        yield ev;
        if (ev.kind === "exited" || ev.kind === "crashed") {
          state.terminalDelivered = true;
          return;
        }
      }
    } finally {
      // Prune the worker state once a watcher has drained it. The
      // fallback prune timer set in proc.exited.then is cleared here so
      // we don't double-delete or prune after a legitimate consumer.
      if (state.pruneTimer !== undefined) {
        clearTimeout(state.pruneTimer);
        state.pruneTimer = undefined;
      }
      if (state.terminalDelivered) workers.delete(id);
    }
  };

  return {
    kind: "subprocess",
    displayName: "Bun subprocess",
    isAvailable: () => typeof Bun !== "undefined" && typeof Bun.spawn === "function",
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

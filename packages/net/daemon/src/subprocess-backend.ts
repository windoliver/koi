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
}

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

    try {
      // Stdio defaults are security- and correctness-conservative:
      //   stdin: "ignore"  — workers do NOT inherit the supervisor's TTY.
      //     A shared TTY would let any worker consume operator keystrokes
      //     intended for the CLI/TUI and let a malicious child interfere
      //     with interactive control. Opt-in stdio modes are a follow-up.
      //   stdout/stderr: "ignore" — pipes would fill OS buffers for chatty
      //     workers and deadlock them (writes block once buffer is full
      //     and nothing drains it). "ignore" routes output to /dev/null.
      //     A future config option will allow draining to logs/telemetry.
      const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      };
      if (request.cwd !== undefined) {
        spawnOptions.cwd = request.cwd;
      }
      const proc = Bun.spawn([...request.command], spawnOptions);

      const controller = new AbortController();
      const state: SubprocState = {
        proc,
        controller,
        events: [],
        listeners: [],
        alive: true,
      };
      workers.set(request.workerId, state);
      emit(state, { kind: "started", workerId: request.workerId, at: Date.now() });

      void proc.exited.then((code) => {
        state.alive = false;
        controller.abort();
        const ev: WorkerEvent =
          code === 0
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
        // Prune the dead worker from the backend's internal map. Callers that
        // generate a fresh workerId per run would otherwise leak SubprocState
        // entries (including AbortController, event buffer, listener arrays)
        // for every worker that ever ran in this supervisor's lifetime.
        workers.delete(request.workerId);
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
    state.proc.kill("SIGTERM");
    return { ok: true, value: undefined };
  };

  const kill = async (id: WorkerId): Promise<Result<void, KoiError>> => {
    const state = workers.get(id);
    if (state === undefined) return { ok: true, value: undefined };
    state.proc.kill("SIGKILL");
    return { ok: true, value: undefined };
  };

  const isAlive = async (id: WorkerId): Promise<boolean> => {
    return workers.get(id)?.alive ?? false;
  };

  const watch = async function* (id: WorkerId): AsyncIterable<WorkerEvent> {
    const state = workers.get(id);
    if (state === undefined) return;
    // Yield buffered events first.
    for (const ev of state.events) yield ev;
    if (!state.alive) return;
    while (state.alive) {
      const ev = await new Promise<WorkerEvent>((resolve) => {
        state.listeners.push(resolve);
      });
      yield ev;
      if (ev.kind === "exited" || ev.kind === "crashed") return;
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

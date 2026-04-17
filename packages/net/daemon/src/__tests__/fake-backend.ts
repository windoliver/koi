import type {
  KoiError,
  Result,
  WorkerBackend,
  WorkerBackendKind,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core";

interface FakeWorkerState {
  alive: boolean;
  readonly controller: AbortController;
  readonly events: WorkerEvent[];
  readonly listeners: Array<(ev: WorkerEvent) => void>;
  readonly emit: (ev: WorkerEvent) => void;
}

export interface FakeBackendControls {
  readonly backend: WorkerBackend;
  readonly crash: (id: WorkerId, at?: number) => void;
  readonly exit: (id: WorkerId, code?: number) => void;
  readonly isAlive: (id: WorkerId) => boolean;
  readonly liveWorkerCount: () => number;
}

export function createFakeBackend(kind: WorkerBackendKind = "in-process"): FakeBackendControls {
  const workers = new Map<WorkerId, FakeWorkerState>();

  const backend: WorkerBackend = {
    kind,
    displayName: "fake",
    isAvailable: () => true,
    spawn: async (req: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
      const controller = new AbortController();
      const state: FakeWorkerState = {
        alive: true,
        controller,
        events: [],
        listeners: [],
        emit: (ev) => {
          state.events.push(ev);
          const pending = [...state.listeners];
          state.listeners.length = 0;
          for (const l of pending) l(ev);
        },
      };
      workers.set(req.workerId, state);
      const handle: WorkerHandle = {
        workerId: req.workerId,
        agentId: req.agentId,
        backendKind: kind,
        startedAt: Date.now(),
        signal: controller.signal,
      };
      state.emit({ kind: "started", workerId: req.workerId, at: Date.now() });
      return { ok: true, value: handle };
    },
    terminate: async (id, _reason) => {
      const s = workers.get(id);
      if (s === undefined) return { ok: true, value: undefined };
      s.alive = false;
      s.controller.abort();
      s.emit({ kind: "exited", workerId: id, at: Date.now(), code: 0, state: "terminated" });
      return { ok: true, value: undefined };
    },
    kill: async (id) => {
      const s = workers.get(id);
      if (s === undefined) return { ok: true, value: undefined };
      s.alive = false;
      s.controller.abort();
      s.emit({ kind: "exited", workerId: id, at: Date.now(), code: 137, state: "terminated" });
      return { ok: true, value: undefined };
    },
    isAlive: async (id) => workers.get(id)?.alive ?? false,
    watch: async function* (id) {
      const s = workers.get(id);
      if (s === undefined) return;
      // Yield buffered events
      for (const ev of s.events) yield ev;
      if (!s.alive) return;
      // Subscribe for future events
      while (s.alive) {
        const ev = await new Promise<WorkerEvent>((resolve) => {
          s.listeners.push(resolve);
        });
        yield ev;
        if (ev.kind === "exited" || ev.kind === "crashed") break;
      }
    },
  };

  return {
    backend,
    crash: (id, at = Date.now()) => {
      const s = workers.get(id);
      if (s === undefined) return;
      s.alive = false;
      s.emit({
        kind: "crashed",
        workerId: id,
        at,
        error: { code: "INTERNAL", message: "test crash", retryable: true },
      });
    },
    exit: (id, code = 0) => {
      const s = workers.get(id);
      if (s === undefined) return;
      s.alive = false;
      s.emit({ kind: "exited", workerId: id, at: Date.now(), code, state: "terminated" });
    },
    isAlive: (id) => workers.get(id)?.alive ?? false,
    liveWorkerCount: () => {
      let n = 0;
      for (const s of workers.values()) if (s.alive) n++;
      return n;
    },
  };
}

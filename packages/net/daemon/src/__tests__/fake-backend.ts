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
  // Most recent heartbeat — replayed on watcher attach so the supervisor's
  // deadline timer doesn't race against a just-dropped heartbeat.
  lastHeartbeat: WorkerEvent | undefined;
}

export interface FakeBackendControls {
  readonly backend: WorkerBackend;
  readonly crash: (id: WorkerId, at?: number) => void;
  readonly heartbeat: (id: WorkerId, at?: number) => void;
  readonly exit: (id: WorkerId, code?: number) => void;
  readonly isAlive: (id: WorkerId) => boolean;
  readonly liveWorkerCount: () => number;
  /** Last pid emitted via the "started" event (undefined if `pidSeed` not set). */
  readonly lastEmittedPid: () => number | undefined;
}

export interface FakeBackendConfig {
  readonly kind?: WorkerBackendKind;
  /**
   * When set, each `spawn()` emits a monotonically increasing pid in the
   * `started` event starting at `pidSeed`. Used by bridge tests that
   * assert pid refresh on restart.
   */
  readonly pidSeed?: number;
  /**
   * Advertises heartbeat support to the supervisor. Tests that opt workers
   * into heartbeat via `backendHints.heartbeat=true` must set this — the
   * supervisor rejects opt-in on backends without heartbeat support to
   * avoid spurious timeouts on backends that never emit `heartbeat` events.
   * Defaults to false (supervisor treats missing flag as "no heartbeat").
   */
  readonly supportsHeartbeat?: boolean;
}

export function createFakeBackend(
  kindOrConfig: WorkerBackendKind | FakeBackendConfig = "in-process",
): FakeBackendControls {
  const config: FakeBackendConfig =
    typeof kindOrConfig === "string" ? { kind: kindOrConfig } : kindOrConfig;
  const kind: WorkerBackendKind = config.kind ?? "in-process";
  const workers = new Map<WorkerId, FakeWorkerState>();
  let nextPid = config.pidSeed;
  let lastPid: number | undefined;

  const backend: WorkerBackend = {
    kind,
    displayName: "fake",
    isAvailable: () => true,
    ...(config.supportsHeartbeat === true && { supportsHeartbeat: true }),
    spawn: async (req: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
      const controller = new AbortController();
      const state: FakeWorkerState = {
        alive: true,
        controller,
        events: [],
        listeners: [],
        lastHeartbeat: undefined,
        emit: (ev) => {
          // Mirror subprocess-backend: heartbeats are live signals, not
          // replay history. We keep only the latest in lastHeartbeat
          // (one-slot) so a late-attaching watcher sees current liveness;
          // the unbounded state.events growth from high-frequency
          // heartbeats is still avoided.
          if (ev.kind === "heartbeat") {
            state.lastHeartbeat = ev;
          } else {
            state.events.push(ev);
          }
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
      let emittedPid: number | undefined;
      if (nextPid !== undefined) {
        emittedPid = nextPid;
        nextPid += 1;
        lastPid = emittedPid;
      }
      state.emit({
        kind: "started",
        workerId: req.workerId,
        at: Date.now(),
        ...(emittedPid !== undefined && { pid: emittedPid }),
      });
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
    watch: async function* (id, signal) {
      const s = workers.get(id);
      if (s === undefined) return;
      if (signal?.aborted) return;
      // See subprocess-backend for full rationale on cursor + cancellation.
      let cancelResolve: (() => void) | undefined;
      // AbortSignal: supervisor aborts on stop()/shutdown() so parked
      // awaits exit even when the backend never emits terminal events.
      const onAbort = (): void => {
        if (cancelResolve !== undefined) {
          const r = cancelResolve;
          cancelResolve = undefined;
          r();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        let cursor = 0;
        // Phase 1: drain existing lifecycle events.
        while (cursor < s.events.length) {
          const ev = s.events[cursor++];
          if (ev === undefined) break;
          yield ev;
          if (ev.kind === "exited" || ev.kind === "crashed") return;
        }
        // Phase 2: replay latest heartbeat for attach-race resistance.
        if (s.lastHeartbeat !== undefined) yield s.lastHeartbeat;
        // Phase 3: re-drain after heartbeat yield.
        while (cursor < s.events.length) {
          const ev = s.events[cursor++];
          if (ev === undefined) break;
          yield ev;
          if (ev.kind === "exited" || ev.kind === "crashed") return;
        }
        // Phase 4: always-drain-then-await with cancellation.
        while (true) {
          if (signal?.aborted) return;
          while (cursor < s.events.length) {
            const ev = s.events[cursor++];
            if (ev === undefined) break;
            yield ev;
            if (ev.kind === "exited" || ev.kind === "crashed") return;
          }
          if (!s.alive) return;
          let eventListener: ((ev: WorkerEvent) => void) | undefined;
          const result = await new Promise<
            { readonly kind: "event"; readonly ev: WorkerEvent } | { readonly kind: "cancel" }
          >((resolve) => {
            eventListener = (ev): void => resolve({ kind: "event", ev });
            s.listeners.push(eventListener);
            cancelResolve = (): void => resolve({ kind: "cancel" });
          });
          cancelResolve = undefined;
          if (eventListener !== undefined) {
            const idx = s.listeners.indexOf(eventListener);
            if (idx !== -1) s.listeners.splice(idx, 1);
          }
          if (result.kind === "cancel") return;
          const ev = result.ev;
          yield ev;
          if (ev.kind !== "heartbeat") cursor++;
          if (ev.kind === "exited" || ev.kind === "crashed") return;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (cancelResolve !== undefined) {
          const r = cancelResolve;
          cancelResolve = undefined;
          r();
        }
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
    heartbeat: (id, at = Date.now()) => {
      const s = workers.get(id);
      if (s === undefined) return;
      s.emit({ kind: "heartbeat", workerId: id, at });
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
    lastEmittedPid: () => lastPid,
  };
}

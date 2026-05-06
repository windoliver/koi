/**
 * wire-daemon-supervisor tests — verifies composition of supervisor +
 * registry + bridge, restart policy, proxy behavior, dispose ordering,
 * and createSupervisor failure propagation.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentManifest, KoiError, Result } from "@koi/core";
import type {
  Supervisor,
  WorkerBackend,
  WorkerBackendKind,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core/daemon";
import type { TuiAction } from "@koi/tui";
import type { WireDaemonSupervisorOptions } from "./wire-daemon-supervisor.js";
import { wireDaemonSupervisor } from "./wire-daemon-supervisor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNullDispatch(): (action: TuiAction) => void {
  return (_action) => {};
}

function makeNullToast(): (t: {
  readonly kind: "info" | "warn" | "error";
  readonly message: string;
}) => void {
  return (_t) => {};
}

const MINIMAL_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "1.0.0",
  model: { name: "test-model" },
};

/** Build a minimal synchronous fake WorkerBackend for tests. */
function makeFakeSubprocessBackend(): WorkerBackend {
  const workers = new Map<
    WorkerId,
    { alive: boolean; listeners: Array<(ev: WorkerEvent) => void> }
  >();

  return {
    kind: "subprocess" as WorkerBackendKind,
    displayName: "fake-subprocess",
    isAvailable: () => true,
    spawn: async (req: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
      workers.set(req.workerId, { alive: true, listeners: [] });
      const handle: WorkerHandle = {
        workerId: req.workerId,
        agentId: req.agentId,
        backendKind: "subprocess",
        startedAt: Date.now(),
        signal: new AbortController().signal,
      };
      // Emit started synchronously so supervisor can observe it
      const state = workers.get(req.workerId);
      if (state !== undefined) {
        const ls = [...state.listeners];
        state.listeners.length = 0;
        for (const l of ls) l({ kind: "started", workerId: req.workerId, at: Date.now() });
      }
      return { ok: true, value: handle };
    },
    terminate: async (id) => {
      const s = workers.get(id);
      if (s === undefined) return { ok: true, value: undefined };
      s.alive = false;
      const ls = [...s.listeners];
      s.listeners.length = 0;
      for (const l of ls)
        l({ kind: "exited", workerId: id, at: Date.now(), code: 0, state: "terminated" });
      return { ok: true, value: undefined };
    },
    kill: async (id) => {
      const s = workers.get(id);
      if (s === undefined) return { ok: true, value: undefined };
      s.alive = false;
      const ls = [...s.listeners];
      s.listeners.length = 0;
      for (const l of ls)
        l({ kind: "exited", workerId: id, at: Date.now(), code: 137, state: "terminated" });
      return { ok: true, value: undefined };
    },
    isAlive: async (id) => workers.get(id)?.alive ?? false,
    watch: async function* (id: WorkerId, signal?: AbortSignal): AsyncIterable<WorkerEvent> {
      const s = workers.get(id);
      if (s === undefined) return;
      while (true) {
        if (signal?.aborted) return;
        if (!s.alive) return;
        const ev = await new Promise<WorkerEvent | "abort">((resolve) => {
          const l = (event: WorkerEvent): void => resolve(event);
          s.listeners.push(l);
          signal?.addEventListener("abort", () => resolve("abort"), { once: true });
        });
        if (ev === "abort") return;
        yield ev;
        if (ev.kind === "exited" || ev.kind === "crashed") return;
      }
    },
  };
}

function makeFakeTmuxBackend(): WorkerBackend {
  const workers = new Map<
    WorkerId,
    { alive: boolean; listeners: Array<(ev: WorkerEvent) => void> }
  >();

  return {
    kind: "tmux" as WorkerBackendKind,
    displayName: "fake-tmux",
    isAvailable: () => true,
    spawn: async (req: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
      workers.set(req.workerId, { alive: true, listeners: [] });
      const handle: WorkerHandle = {
        workerId: req.workerId,
        agentId: req.agentId,
        backendKind: "tmux",
        tmuxSessionName: `koi-${String(req.workerId)}`,
        tmuxWindowTarget: `koi-${String(req.workerId)}:0`,
        tmuxPaneId: "%42",
        startedAt: Date.now(),
        signal: new AbortController().signal,
      };
      const state = workers.get(req.workerId);
      if (state !== undefined) {
        const listeners = [...state.listeners];
        state.listeners.length = 0;
        for (const listener of listeners) {
          listener({
            kind: "started",
            workerId: req.workerId,
            at: Date.now(),
            pid: 4242,
          });
        }
      }
      return { ok: true, value: handle };
    },
    terminate: async (id) => {
      const state = workers.get(id);
      if (state === undefined) return { ok: true, value: undefined };
      state.alive = false;
      const listeners = [...state.listeners];
      state.listeners.length = 0;
      for (const listener of listeners) {
        listener({ kind: "exited", workerId: id, at: Date.now(), code: 0, state: "terminated" });
      }
      return { ok: true, value: undefined };
    },
    kill: async (id) => {
      const state = workers.get(id);
      if (state === undefined) return { ok: true, value: undefined };
      state.alive = false;
      const listeners = [...state.listeners];
      state.listeners.length = 0;
      for (const listener of listeners) {
        listener({
          kind: "exited",
          workerId: id,
          at: Date.now(),
          code: 137,
          state: "terminated",
        });
      }
      return { ok: true, value: undefined };
    },
    isAlive: async (id) => workers.get(id)?.alive ?? false,
    watch: async function* (id: WorkerId, signal?: AbortSignal): AsyncIterable<WorkerEvent> {
      const state = workers.get(id);
      if (state === undefined) return;
      while (true) {
        if (signal?.aborted) return;
        if (!state.alive) return;
        const ev = await new Promise<WorkerEvent | "abort">((resolve) => {
          const listener = (event: WorkerEvent): void => resolve(event);
          state.listeners.push(listener);
          signal?.addEventListener("abort", () => resolve("abort"), { once: true });
        });
        if (ev === "abort") return;
        yield ev;
        if (ev.kind === "exited" || ev.kind === "crashed") return;
      }
    },
  };
}

function makeSupervisorDouble(
  overrides: {
    readonly start?: Supervisor["start"];
    readonly stop?: Supervisor["stop"];
    readonly shutdown?: Supervisor["shutdown"];
  } = {},
): Supervisor {
  return {
    start:
      overrides.start ??
      (async () => ({
        ok: false,
        error: { code: "INTERNAL", message: "stub start", retryable: false },
      })),
    stop: overrides.stop ?? (async () => ({ ok: true, value: undefined })),
    shutdown: overrides.shutdown ?? (async () => ({ ok: true, value: undefined })),
    list: () => [],
    watchAll: async function* () {},
    health: () => ({
      status: "ok",
      reasons: [],
      metrics: {
        poolSize: 0,
        maxWorkers: 1,
        quarantinedCount: 0,
        restartingCount: 0,
        pendingSpawnCount: 0,
        eventDropCount: 0,
        shuttingDown: false,
      },
      workers: [],
    }),
  };
}

async function waitForRegistryRecord(
  getter: () => Promise<unknown>,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await getter();
    if (predicate(value)) return value;
    await Bun.sleep(5);
  }
  return getter();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-wire-sup-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wireDaemonSupervisor", () => {
  it("instantiates supervisor + registry + bridge for subprocess manifest", async () => {
    const backend = makeFakeSubprocessBackend();
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: backend },
    };

    const handle = await wireDaemonSupervisor(opts);
    try {
      expect(handle.supervisor).toBeDefined();
      expect(handle.registry).toBeDefined();
      expect(handle.bridge).toBeDefined();
      expect(typeof handle.dispose).toBe("function");
    } finally {
      await handle.dispose();
    }
  });

  it("daemon-spawned children configured with restart: temporary, maxRestarts: 0", async () => {
    // We verify the restart policy by mocking createSupervisor and capturing
    // the config it receives.
    const daemonModule = await import("@koi/daemon");
    let capturedConfig: Parameters<typeof daemonModule.createSupervisor>[0] | undefined;
    const originalCreate = daemonModule.createSupervisor;
    const spy = spyOn(daemonModule, "createSupervisor").mockImplementation((config) => {
      capturedConfig = config;
      return originalCreate(config);
    });

    const backend = makeFakeSubprocessBackend();
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: backend },
    };

    const handle = await wireDaemonSupervisor(opts);
    await handle.dispose();

    spy.mockRestore();

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig?.restart?.restart).toBe("temporary");
    expect(capturedConfig?.restart?.maxRestarts).toBe(0);
  });

  it("supervisor.start proxy calls bridge.markLocallySpawned before underlying start", async () => {
    const backend = makeFakeSubprocessBackend();
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: backend },
    };

    const handle = await wireDaemonSupervisor(opts);

    const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
    const wId = makeWorkerId("w-proxy-test");
    const aId = makeAgentId("agent-proxy-test");

    // Track call order: markLocallySpawned should fire BEFORE start resolves.
    const orderLog: string[] = [];
    const markSpy = spyOn(handle.bridge, "markLocallySpawned").mockImplementation((id) => {
      orderLog.push(`mark:${id}`);
    });

    await handle.supervisor.start({ workerId: wId, agentId: aId, command: ["test"] });
    orderLog.push("start-resolved");

    expect(orderLog[0]).toBe(`mark:${String(wId)}`);
    expect(orderLog[1]).toBe("start-resolved");
    expect(markSpy).toHaveBeenCalledWith(String(wId));

    await handle.dispose();
  });

  it("supervisor.start proxy unmarks locallySpawnedId when realSupervisor.start returns ok:false", async () => {
    // Regression for the ownership-marker leak: failed admission paths
    // (capacity, duplicate id, backend error) return ok:false without any
    // terminal lifecycle event, so the bridge's event-driven cleanup never
    // runs. The proxy must remove the marker itself.
    const backend = makeFakeSubprocessBackend();
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: backend },
    };

    const handle = await wireDaemonSupervisor(opts);

    const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
    const wId = makeWorkerId("w-failed-start");
    const aId = makeAgentId("agent-failed-start");

    const markSpy = spyOn(handle.bridge, "markLocallySpawned");
    const unmarkSpy = spyOn(handle.bridge, "unmarkLocallySpawned");

    // Force start() to return ok:false by spawning the same workerId twice
    // (first succeeds, second hits duplicate-id rejection).
    const okResult = await handle.supervisor.start({
      workerId: wId,
      agentId: aId,
      command: ["test"],
    });
    expect(okResult.ok).toBe(true);

    const failResult = await handle.supervisor.start({
      workerId: wId,
      agentId: aId,
      command: ["test"],
    });
    expect(failResult.ok).toBe(false);

    expect(markSpy).toHaveBeenCalledTimes(2);
    // unmark only on the failed start
    expect(unmarkSpy).toHaveBeenCalledTimes(1);
    expect(unmarkSpy).toHaveBeenCalledWith(String(wId));

    await handle.dispose();
  });

  it("registers tmux-backed workers with tmux metadata from the spawn path", async () => {
    const backend = makeFakeTmuxBackend();
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { tmux: backend },
    };

    const handle = await wireDaemonSupervisor(opts);
    try {
      const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
      const wId = makeWorkerId("w-tmux-reg");
      const aId = makeAgentId("agent-tmux-reg");

      const started = await handle.supervisor.start(
        { workerId: wId, agentId: aId, command: ["bun", "--version"] },
        { backend: "tmux" },
      );
      expect(started.ok).toBe(true);

      const record = (await waitForRegistryRecord(
        () => handle.registry.get(wId),
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "backendKind" in value &&
          "tmuxSessionName" in value &&
          "tmuxWindowTarget" in value &&
          "tmuxPaneId" in value,
      )) as Awaited<ReturnType<typeof handle.registry.get>>;

      expect(record).toMatchObject({
        backendKind: "tmux",
        tmuxSessionName: "koi-w-tmux-reg",
        tmuxWindowTarget: "koi-w-tmux-reg:0",
        tmuxPaneId: "%42",
      });
    } finally {
      await handle.dispose();
    }
  });

  it("keeps the pre-registered row when ok:false start cannot be safely torn down", async () => {
    const daemonModule = await import("@koi/daemon");
    const createSpy = spyOn(daemonModule, "createSupervisor").mockReturnValue({
      ok: true,
      value: makeSupervisorDouble({
        start: async () => ({
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "backend.spawn did not resolve in time",
            retryable: true,
          },
        }),
        stop: async () => ({
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "worker may still be alive",
            retryable: true,
          },
        }),
      }),
    });

    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: makeFakeSubprocessBackend() },
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();
    try {
      const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
      const wId = makeWorkerId("w-timeout-reg");
      const aId = makeAgentId("agent-timeout-reg");

      const started = await handle.supervisor.start({
        workerId: wId,
        agentId: aId,
        command: ["test"],
      });

      expect(started.ok).toBe(false);
      const record = await handle.registry.get(wId);
      expect(record).toMatchObject({
        workerId: wId,
        backendKind: "subprocess",
        status: "starting",
      });
    } finally {
      await handle.dispose();
    }
  });

  it("does not stop an existing live worker when ok:false is a duplicate-id conflict", async () => {
    const stopCalls: string[] = [];
    const daemonModule = await import("@koi/daemon");
    const createSpy = spyOn(daemonModule, "createSupervisor").mockReturnValue({
      ok: true,
      value: makeSupervisorDouble({
        start: async () => ({
          ok: false,
          error: {
            code: "CONFLICT",
            message: "Worker w-conflict-stale is already active (live or mid-restart)",
            retryable: false,
          },
        }),
        stop: async (workerId) => {
          stopCalls.push(String(workerId));
          return { ok: true, value: undefined };
        },
      }),
    });

    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: makeFakeSubprocessBackend() },
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();
    try {
      const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
      const wId = makeWorkerId("w-conflict-stale");
      const aId = makeAgentId("agent-conflict-stale");

      const started = await handle.supervisor.start({
        workerId: wId,
        agentId: aId,
        command: ["test"],
      });

      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.error.code).toBe("CONFLICT");
      }
      expect(stopCalls).toEqual([]);
      expect(await handle.registry.get(wId)).toBeUndefined();
    } finally {
      await handle.dispose();
    }
  });

  it("keeps the registry row when backend-mismatch cleanup stop fails", async () => {
    const stopSpy = async (): Promise<Result<void, KoiError>> => ({
      ok: false,
      error: {
        code: "INTERNAL",
        message: "teardown failed",
        retryable: true,
      },
    });
    const daemonModule = await import("@koi/daemon");
    const createSpy = spyOn(daemonModule, "createSupervisor").mockReturnValue({
      ok: true,
      value: makeSupervisorDouble({
        start: async (request) => ({
          ok: true,
          value: {
            workerId: request.workerId,
            agentId: request.agentId,
            backendKind: "subprocess",
            startedAt: Date.now(),
            signal: new AbortController().signal,
          },
        }),
        stop: stopSpy,
      }),
    });

    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { tmux: makeFakeTmuxBackend() },
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();
    try {
      const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
      const wId = makeWorkerId("w-mismatch-reg");
      const aId = makeAgentId("agent-mismatch-reg");

      const started = await handle.supervisor.start(
        { workerId: wId, agentId: aId, command: ["test"] },
        { backend: "tmux" },
      );

      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.error.code).toBe("INTERNAL");
        expect(started.error.message).toContain("teardown failed");
      }
      const record = await handle.registry.get(wId);
      expect(record).toMatchObject({
        workerId: wId,
        backendKind: "tmux",
        status: "starting",
      });
    } finally {
      await handle.dispose();
    }
  });

  it("keeps the registry row when metadata persistence cleanup stop fails", async () => {
    const daemonModule = await import("@koi/daemon");
    const createSpy = spyOn(daemonModule, "createSupervisor").mockReturnValue({
      ok: true,
      value: makeSupervisorDouble({
        start: async (request) => ({
          ok: true,
          value: {
            workerId: request.workerId,
            agentId: request.agentId,
            backendKind: "tmux",
            tmuxSessionName: `koi-${String(request.workerId)}`,
            tmuxWindowTarget: `koi-${String(request.workerId)}:0`,
            tmuxPaneId: "%77",
            startedAt: Date.now(),
            signal: new AbortController().signal,
          },
        }),
        stop: async () => ({
          ok: false,
          error: {
            code: "INTERNAL",
            message: "stop could not confirm exit",
            retryable: true,
          },
        }),
      }),
    });

    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { tmux: makeFakeTmuxBackend() },
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();
    try {
      const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
      const wId = makeWorkerId("w-update-reg");
      const aId = makeAgentId("agent-update-reg");

      const updateSpy = spyOn(handle.registry, "update").mockResolvedValue({
        ok: false,
        error: {
          code: "INTERNAL",
          message: "disk full",
          retryable: false,
        },
      });

      const started = await handle.supervisor.start(
        { workerId: wId, agentId: aId, command: ["test"] },
        { backend: "tmux" },
      );

      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.error.code).toBe("INTERNAL");
        expect(started.error.message).toContain("stop could not confirm exit");
      }
      const record = await handle.registry.get(wId);
      expect(record).toMatchObject({
        workerId: wId,
        backendKind: "tmux",
        status: "starting",
      });
      updateSpy.mockRestore();
    } finally {
      await handle.dispose();
    }
  });

  it("uses the bounded probe path when one compatible backend hangs", async () => {
    let startCalled = false;
    const daemonModule = await import("@koi/daemon");
    const createSpy = spyOn(daemonModule, "createSupervisor").mockReturnValue({
      ok: true,
      value: makeSupervisorDouble({
        start: async () => {
          startCalled = true;
          return {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "backend unavailable",
              retryable: false,
            },
          };
        },
      }),
    });

    const hangingBackend: WorkerBackend = {
      ...makeFakeSubprocessBackend(),
      isAvailable: () => new Promise<boolean>(() => {}),
    };
    const fallbackBackend: WorkerBackend = {
      ...makeFakeTmuxBackend(),
      isAvailable: () => true,
    };
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: hangingBackend, tmux: fallbackBackend },
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();
    try {
      const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
      const before = Date.now();
      const started = await handle.supervisor.start({
        workerId: makeWorkerId("w-hanging-probe"),
        agentId: makeAgentId("agent-hanging-probe"),
        command: ["test"],
      });
      const elapsed = Date.now() - before;

      expect(startCalled).toBe(true);
      expect(started.ok).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(1500);
    } finally {
      await handle.dispose();
    }
  });

  it("cleans up the local ownership marker when backend resolution throws before start", async () => {
    const daemonModule = await import("@koi/daemon");
    const createSpy = spyOn(daemonModule, "createSupervisor").mockReturnValue({
      ok: true,
      value: makeSupervisorDouble({
        start: async () => {
          throw new Error("realSupervisor.start should not be reached");
        },
      }),
    });

    const throwingBackends = new Proxy(
      { tmux: makeFakeTmuxBackend() } as WireDaemonSupervisorOptions["backends"],
      {
        get(target, prop, receiver) {
          if (prop === "subprocess") {
            throw new Error("backend lookup exploded");
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    );

    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: throwingBackends,
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();
    try {
      const { workerId: makeWorkerId, agentId: makeAgentId } = await import("@koi/core");
      const wId = makeWorkerId("w-resolution-throw");
      const unmarkSpy = spyOn(handle.bridge, "unmarkLocallySpawned");

      await expect(
        handle.supervisor.start({
          workerId: wId,
          agentId: makeAgentId("agent-resolution-throw"),
          command: ["test"],
        }),
      ).rejects.toThrow("backend lookup exploded");

      expect(unmarkSpy).toHaveBeenCalledWith(String(wId));
      expect(await handle.registry.get(wId)).toBeUndefined();
    } finally {
      await handle.dispose();
    }
  });

  it("dispose tears down in order: supervisor.shutdown → bridge.close → attachHandle.close", async () => {
    // We intercept createSupervisor to inject an instrumented shutdown.
    // The dispose() closure holds a direct reference to realSupervisor (not
    // the proxied copy), so the only way to intercept it from outside is to
    // instrument at creation time.
    const orderLog: string[] = [];
    let shutdownTs = -1;
    let bridgeCloseTs = -1;
    let counter = 0;

    const daemonModule = await import("@koi/daemon");
    const originalCreate = daemonModule.createSupervisor;
    const createSpy = spyOn(daemonModule, "createSupervisor").mockImplementation((config) => {
      const result = originalCreate(config);
      if (!result.ok) return result;
      const realSup = result.value;
      const instrumented = {
        ...realSup,
        shutdown: async (reason: string) => {
          orderLog.push("supervisor.shutdown");
          shutdownTs = ++counter;
          return realSup.shutdown(reason);
        },
      };
      return { ok: true, value: instrumented };
    });

    const backend = makeFakeSubprocessBackend();
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: { subprocess: backend },
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();

    // Intercept bridge.close via the returned handle (this IS the bridge object)
    const origBridgeClose = handle.bridge.close;
    // biome-ignore lint/suspicious/noExplicitAny: test instrumentation requires mutation of readonly
    (handle.bridge as any).close = async () => {
      orderLog.push("bridge.close");
      bridgeCloseTs = ++counter;
      return origBridgeClose();
    };

    await handle.dispose();

    expect(orderLog).toContain("supervisor.shutdown");
    expect(orderLog).toContain("bridge.close");
    expect(shutdownTs).toBeLessThan(bridgeCloseTs);
    expect(orderLog.indexOf("supervisor.shutdown")).toBeLessThan(orderLog.indexOf("bridge.close"));
  });

  it("dispose surfaces shutdown failure as toast + thrown error; still tears down bridge + registry", async () => {
    // Regression: shutdown() can fail (deadline exceeded, backend teardown
    // error). The previous dispose() awaited the result without checking ok
    // and tore down the bridge anyway, hiding orphaned workers from the TUI.
    const daemonModule = await import("@koi/daemon");
    const originalCreate = daemonModule.createSupervisor;
    const createSpy = spyOn(daemonModule, "createSupervisor").mockImplementation((config) => {
      const result = originalCreate(config);
      if (!result.ok) return result;
      const realSup = result.value;
      const failingError: KoiError = {
        code: "TIMEOUT",
        message: "deadline exceeded",
        retryable: false,
      };
      const instrumented = {
        ...realSup,
        shutdown: async (_reason: string): Promise<Result<void, KoiError>> => ({
          ok: false,
          error: failingError,
        }),
      };
      return { ok: true, value: instrumented };
    });

    const backend = makeFakeSubprocessBackend();
    const toasts: { kind: string; message: string }[] = [];
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: (t) => {
        toasts.push(t);
      },
      backends: { subprocess: backend },
    };

    const handle = await wireDaemonSupervisor(opts);
    createSpy.mockRestore();

    let bridgeClosed = false;
    const origBridgeClose = handle.bridge.close;
    // biome-ignore lint/suspicious/noExplicitAny: test instrumentation requires mutation of readonly
    (handle.bridge as any).close = async () => {
      bridgeClosed = true;
      return origBridgeClose();
    };

    await expect(handle.dispose()).rejects.toThrow("supervisor.shutdown failed");
    expect(bridgeClosed).toBe(true);
    const warnToast = toasts.find((t) => t.message.includes("supervisor shutdown failed"));
    expect(warnToast).toBeDefined();
  });

  it("createSupervisor failure throws with cause chaining", async () => {
    // Pass empty backends to trigger the validateSupervisorConfig error
    const opts: WireDaemonSupervisorOptions = {
      stateDir: tmpDir,
      manifest: MINIMAL_MANIFEST,
      dispatch: makeNullDispatch(),
      pushToast: makeNullToast(),
      backends: {}, // empty backends → validation error
    };

    await expect(wireDaemonSupervisor(opts)).rejects.toThrow("createSupervisor failed");
  });
});

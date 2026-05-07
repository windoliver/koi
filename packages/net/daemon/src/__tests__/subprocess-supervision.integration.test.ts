/**
 * End-to-end integration test for subprocess-isolated supervision (3b-5c).
 *
 * Wires the full stack:
 *
 *   wireSupervision
 *     ├─ createDispatchingSpawnChildFn
 *     │    ├─ inProcess: createInProcessSpawnChildFn (bypassed — all children are subprocess here)
 *     │    └─ subprocess: createDaemonSpawnChildFn
 *     │         ├─ supervisor.start  ──▶  fake backend spawn
 *     │         ├─ sessionRegistry.register
 *     │         └─ agentRegistry.register
 *     ├─ attachAgentRegistry  (supervisor events → AgentRegistry transitions)
 *     └─ attachRegistry       (supervisor events → BackgroundSessionRegistry updates)
 *
 * Fake backend stands in for real OS spawn so the test is deterministic;
 * the spawn path under test is the adapter/bridge wiring, not Bun.spawn
 * itself (which is already covered by `subprocess-backend.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentId,
  AgentManifest,
  KoiError,
  PatchableRegistryFields,
  ProcessDescriptor,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  Result,
  TransitionReason,
  VisibilityContext,
  WorkerEvent,
} from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { attachAgentRegistry } from "../agent-registry-bridge.js";
import { createSupervisor } from "../create-supervisor.js";
import { createDaemonSpawnChildFn } from "../daemon-spawn-child-fn.js";
import { createFileSessionRegistry } from "../file-session-registry.js";
import { attachRegistry } from "../registry-supervisor-bridge.js";
import { createTmuxBackend } from "../tmux-backend.js";
import { createFakeBackend } from "./fake-backend.js";

let dir: string;
const E2E = process.env.RUN_E2E === "1" || process.env.RUN_E2E === "true";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koi-3b5c-integration-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RECONCILE_WAIT_MS = 350;
const BRIDGE_EVENT_WAIT_MS = 100;

interface SyncRegistryLike {
  readonly deregister: (agentId: AgentId) => boolean | Promise<boolean>;
  readonly lookup: (
    agentId: AgentId,
  ) => RegistryEntry | undefined | Promise<RegistryEntry | undefined>;
  register(entry: {
    readonly agentId: AgentId;
    readonly status: RegistryEntry["status"];
    readonly agentType: string;
    readonly metadata: Record<string, unknown>;
    readonly registeredAt: number;
    readonly priority: number;
  }): RegistryEntry | Promise<RegistryEntry>;
  list(
    filter?: RegistryFilter,
    visibility?: VisibilityContext,
  ): readonly RegistryEntry[] | Promise<readonly RegistryEntry[]>;
  readonly transition: (
    agentId: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ) => Result<RegistryEntry, KoiError> | Promise<Result<RegistryEntry, KoiError>>;
  readonly patch: (
    agentId: AgentId,
    fields: PatchableRegistryFields,
  ) => Result<RegistryEntry, KoiError> | Promise<Result<RegistryEntry, KoiError>>;
  readonly watch: (listener: (event: RegistryEvent) => void) => () => void;
  readonly descriptor?: (
    agentId: AgentId,
  ) => ProcessDescriptor | undefined | Promise<ProcessDescriptor | undefined>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

interface EngineModule {
  readonly createDispatchingSpawnChildFn: (...args: unknown[]) => unknown;
  readonly createInProcessSpawnChildFn: (...args: unknown[]) => unknown;
  readonly wireSupervision: (...args: unknown[]) => {
    readonly reconcileRunner: { sweep(): void };
    [Symbol.asyncDispose](): Promise<void>;
  };
}

interface EngineReconcileModule {
  readonly createInMemoryRegistry: () => SyncRegistryLike;
}

const SUPERVISOR_MANIFEST: AgentManifest = {
  name: "subprocess-supervisor",
  version: "1.0.0",
  model: { name: "test-model" },
  supervision: {
    strategy: { kind: "one_for_one" },
    maxRestarts: 10,
    maxRestartWindowMs: 60_000,
    children: [{ name: "worker", restart: "permanent", isolation: "subprocess" }],
  },
};

function registerSupervisor(registry: SyncRegistryLike, id: AgentId): RegistryEntry {
  const entry = registry.register({
    agentId: id,
    status: {
      phase: "running",
      generation: 0,
      conditions: [],
      reason: { kind: "assembly_complete" },
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
  });
  if (entry instanceof Promise) throw new Error("sync registry expected");
  return entry;
}

function liveChildrenOf(registry: SyncRegistryLike, parentId: AgentId): readonly RegistryEntry[] {
  const all = registry.list();
  if (all instanceof Promise) throw new Error("sync list expected");
  return all.filter((entry: RegistryEntry) => {
    return entry.parentId === parentId && entry.status.phase !== "terminated";
  });
}

async function loadEngineModules(): Promise<{
  readonly engine: EngineModule;
  readonly reconcile: EngineReconcileModule;
}> {
  const dispatchUrl = new URL(
    "../../../../kernel/engine/src/dispatching-spawn-child-fn.ts",
    import.meta.url,
  );
  const inProcessUrl = new URL(
    "../../../../kernel/engine/src/in-process-spawn-child-fn.ts",
    import.meta.url,
  );
  const wireUrl = new URL("../../../../kernel/engine/src/wire-supervision.ts", import.meta.url);
  const reconcileUrl = new URL(
    "../../../../kernel/engine-reconcile/src/registry.ts",
    import.meta.url,
  );
  const [dispatching, inProcess, wire, reconcile] = await Promise.all([
    import(dispatchUrl.pathname),
    import(inProcessUrl.pathname),
    import(wireUrl.pathname),
    import(reconcileUrl.pathname),
  ]);
  return {
    engine: {
      createDispatchingSpawnChildFn: (
        dispatching as {
          createDispatchingSpawnChildFn: EngineModule["createDispatchingSpawnChildFn"];
        }
      ).createDispatchingSpawnChildFn,
      createInProcessSpawnChildFn: (
        inProcess as { createInProcessSpawnChildFn: EngineModule["createInProcessSpawnChildFn"] }
      ).createInProcessSpawnChildFn,
      wireSupervision: (wire as { wireSupervision: EngineModule["wireSupervision"] })
        .wireSupervision,
    },
    reconcile: reconcile as unknown as EngineReconcileModule,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

describe("subprocess supervision end-to-end (3b-5c)", () => {
  test("wireSupervision spawns subprocess children via the daemon adapter", async () => {
    const { engine, reconcile } = await loadEngineModules();
    const createDispatchingSpawnChildFn = engine.createDispatchingSpawnChildFn as (
      args: unknown,
    ) => unknown;
    const createInProcessSpawnChildFn = engine.createInProcessSpawnChildFn as (
      args: unknown,
    ) => unknown;
    const wireSupervision = engine.wireSupervision as (args: unknown) => {
      readonly reconcileRunner: { sweep(): void };
      [Symbol.asyncDispose](): Promise<void>;
    };
    const { backend } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
    });
    if (!supResult.ok) throw new Error("supervisor failed to create");
    const supervisor = supResult.value;

    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = reconcile.createInMemoryRegistry();
    const registryBridge = attachRegistry({ supervisor, registry: sessionRegistry });
    const agentBridge = attachAgentRegistry({
      supervisor,
      agentRegistry,
    });

    const subprocessSpawn = createDaemonSpawnChildFn({
      supervisor,
      sessionRegistry,
      agentRegistry,
      bridge: agentBridge,
      commandBuilder: () => ["noop"],
    });

    const inProcessSpawn = createInProcessSpawnChildFn({
      registry: agentRegistry,
      spawn: async () => {
        throw new Error("in-process branch must not be hit for subprocess-only supervisor");
      },
    });

    const dispatch = createDispatchingSpawnChildFn({
      inProcess: inProcessSpawn,
      subprocess: subprocessSpawn,
    });

    const parent = agentId("sub-sup-1");
    const wire = wireSupervision({
      registry: agentRegistry,
      manifests: new Map([[parent, SUPERVISOR_MANIFEST]]),
      spawnChild: dispatch,
    });

    // Register the supervisor after wireSupervision so ProcessTree's watch
    // bridge sees the registration event.
    registerSupervisor(agentRegistry, parent);

    // Drive the first reconcile.
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const children = liveChildrenOf(agentRegistry, parent);
    expect(children.length).toBe(1);
    const firstChild = children[0];
    if (firstChild === undefined) throw new Error("child missing after initial reconcile");
    // Daemon adapter mints "<parent>.<childSpec>-<suffix>" agentIds.
    expect(firstChild.agentId.startsWith(`${parent}.worker-`)).toBe(true);
    expect(firstChild.metadata.childSpecName).toBe("worker");

    // A BackgroundSessionRecord was written with backendKind="subprocess".
    const sessions = await sessionRegistry.list();
    expect(sessions.some((s) => s.backendKind === "subprocess")).toBe(true);

    // The `started` event from the fake backend should have flowed through
    // attachAgentRegistry and transitioned the child to running.
    for (let i = 0; i < 20; i++) {
      const current = liveChildrenOf(agentRegistry, parent);
      if (current[0]?.status.phase === "running") break;
      await Bun.sleep(10);
    }
    const runningChildren = liveChildrenOf(agentRegistry, parent);
    expect(runningChildren[0]?.status.phase).toBe("running");

    await wire[Symbol.asyncDispose]();
    await registryBridge.close();
    await agentBridge.close();
    await supervisor.shutdown("test-done");
  }, 10_000);

  test("supervisor restarts a crashed subprocess child", async () => {
    const { engine, reconcile } = await loadEngineModules();
    const createDispatchingSpawnChildFn = engine.createDispatchingSpawnChildFn as (
      args: unknown,
    ) => unknown;
    const createInProcessSpawnChildFn = engine.createInProcessSpawnChildFn as (
      args: unknown,
    ) => unknown;
    const wireSupervision = engine.wireSupervision as (args: unknown) => {
      readonly reconcileRunner: { sweep(): void };
      [Symbol.asyncDispose](): Promise<void>;
    };
    const { backend, crash } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
      restart: {
        restart: "permanent",
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 10,
        backoffCeilingMs: 50,
      },
    });
    if (!supResult.ok) throw new Error("supervisor failed");
    const supervisor = supResult.value;

    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = reconcile.createInMemoryRegistry();
    const registryBridge = attachRegistry({ supervisor, registry: sessionRegistry });
    const agentBridge = attachAgentRegistry({ supervisor, agentRegistry });

    const subprocessSpawn = createDaemonSpawnChildFn({
      supervisor,
      sessionRegistry,
      agentRegistry,
      bridge: agentBridge,
      commandBuilder: () => ["noop"],
    });
    const inProcessSpawn = createInProcessSpawnChildFn({
      registry: agentRegistry,
      spawn: async () => {
        throw new Error("in-process branch unused");
      },
    });
    const dispatch = createDispatchingSpawnChildFn({
      inProcess: inProcessSpawn,
      subprocess: subprocessSpawn,
    });

    const parent = agentId("sub-sup-crash");
    const wire = wireSupervision({
      registry: agentRegistry,
      manifests: new Map([[parent, SUPERVISOR_MANIFEST]]),
      spawnChild: dispatch,
    });
    registerSupervisor(agentRegistry, parent);

    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const first = liveChildrenOf(agentRegistry, parent);
    expect(first.length).toBe(1);
    const firstChild = first[0];
    if (firstChild === undefined) throw new Error("child missing after initial reconcile");
    const firstAgentId = firstChild.agentId;

    // Find the mapped workerId for the first child via session registry.
    const sessions = await sessionRegistry.list();
    const session = sessions.find((s) => s.agentId === firstAgentId);
    if (session === undefined) throw new Error("no session for first child");

    // Simulate a crash from the subprocess backend. attachAgentRegistry
    // should observe the `crashed` WorkerEvent and transition the agent
    // entry to `terminated`; the supervision reconciler's next sweep
    // observes the terminated child and respawns it under a fresh agentId
    // (the permanent restart policy).
    crash(session.workerId);
    // Let the bridge drain the crash event before we sweep.
    await Bun.sleep(BRIDGE_EVENT_WAIT_MS);
    // Nudge the reconciler to observe the terminated child.
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const afterRestart = liveChildrenOf(agentRegistry, parent);
    expect(afterRestart.length).toBe(1);
    const restarted = afterRestart[0];
    if (restarted === undefined) throw new Error("no child after restart");
    expect(restarted.agentId).not.toBe(firstAgentId);
    expect(restarted.metadata.childSpecName).toBe("worker");

    await wire[Symbol.asyncDispose]();
    await registryBridge.close();
    await agentBridge.close();
    await supervisor.shutdown("test-done");
  }, 15_000);

  test.skipIf(!E2E)(
    "tmux backend spawns a worker pane and reports liveness",
    async () => {
      const backend = createTmuxBackend({
        cwd: dir,
        pollIntervalMs: 25,
      });

      expect(await backend.isAvailable()).toBe(true);

      const wid = workerId("tmux-e2e-worker");
      const seen: WorkerEvent["kind"][] = [];
      const watchDone = (async () => {
        for await (const ev of backend.watch(wid)) {
          seen.push(ev.kind);
          if (ev.kind === "exited" || ev.kind === "crashed") break;
        }
      })();

      const spawned = await backend.spawn({
        workerId: wid,
        agentId: agentId("tmux.e2e.agent"),
        command: ["bash", "-lc", "sleep 30"],
        cwd: dir,
      });

      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      expect(spawned.value.backendKind).toBe("tmux");
      expect(spawned.value.tmuxSessionName).toMatch(/-daemon-workers$/);
      expect(spawned.value.tmuxWindowTarget).toContain(`${spawned.value.tmuxSessionName}:`);
      expect(spawned.value.tmuxPaneId).toMatch(/^%/);
      expect(await backend.isAlive(wid)).toBe(true);
      expect(await waitFor(() => seen.includes("started"), 2_000)).toBe(true);

      const stopped = await backend.terminate(wid, "test-complete");
      expect(stopped.ok).toBe(true);
      await watchDone;

      expect(seen).toContain("exited");
      expect(await backend.isAlive(wid)).toBe(false);
    },
    15_000,
  );
});

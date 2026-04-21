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
import type { AgentId, AgentManifest, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import {
  createDispatchingSpawnChildFn,
  createInProcessSpawnChildFn,
  wireSupervision,
} from "@koi/engine";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { attachAgentRegistry } from "../agent-registry-bridge.js";
import { createSupervisor } from "../create-supervisor.js";
import { createDaemonSpawnChildFn } from "../daemon-spawn-child-fn.js";
import { createFileSessionRegistry } from "../file-session-registry.js";
import { attachRegistry } from "../registry-supervisor-bridge.js";
import { createFakeBackend } from "./fake-backend.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koi-3b5c-integration-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RECONCILE_WAIT_MS = 350;
const BRIDGE_EVENT_WAIT_MS = 100;

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

function registerSupervisor(
  registry: ReturnType<typeof createInMemoryRegistry>,
  id: AgentId,
): RegistryEntry {
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

function liveChildrenOf(
  registry: ReturnType<typeof createInMemoryRegistry>,
  parentId: AgentId,
): readonly RegistryEntry[] {
  const all = registry.list();
  if (all instanceof Promise) throw new Error("sync list expected");
  return all.filter((e) => e.parentId === parentId && e.status.phase !== "terminated");
}

describe("subprocess supervision end-to-end (3b-5c)", () => {
  test("wireSupervision spawns subprocess children via the daemon adapter", async () => {
    const { backend } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
    });
    if (!supResult.ok) throw new Error("supervisor failed to create");
    const supervisor = supResult.value;

    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = createInMemoryRegistry();
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
    // Daemon adapter mints "<parent>.<childSpec>-<suffix>" agentIds.
    expect(children[0]!.agentId.startsWith(`${parent}.worker-`)).toBe(true);
    expect(children[0]!.metadata.childSpecName).toBe("worker");

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
    const agentRegistry = createInMemoryRegistry();
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
    const firstAgentId = first[0]!.agentId;

    // Find the mapped workerId for the first child via session registry.
    const sessions = await sessionRegistry.list();
    const session = sessions.find((s) => s.agentId === firstAgentId);
    expect(session).toBeDefined();

    // Simulate a crash from the subprocess backend. attachAgentRegistry
    // should observe the `crashed` WorkerEvent and transition the agent
    // entry to `terminated`; the supervision reconciler's next sweep
    // observes the terminated child and respawns it under a fresh agentId
    // (the permanent restart policy).
    crash(session!.workerId);
    // Let the bridge drain the crash event before we sweep.
    await Bun.sleep(BRIDGE_EVENT_WAIT_MS);
    // Nudge the reconciler to observe the terminated child.
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const afterRestart = liveChildrenOf(agentRegistry, parent);
    expect(afterRestart.length).toBe(1);
    expect(afterRestart[0]!.agentId).not.toBe(firstAgentId);
    expect(afterRestart[0]!.metadata.childSpecName).toBe("worker");

    await wire[Symbol.asyncDispose]();
    await registryBridge.close();
    await agentBridge.close();
    await supervisor.shutdown("test-done");
  }, 15_000);
});

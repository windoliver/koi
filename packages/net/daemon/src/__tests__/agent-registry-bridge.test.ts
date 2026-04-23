import { describe, expect, it } from "bun:test";
import type {
  AgentId,
  AgentRegistry,
  PatchableRegistryFields,
  ProcessState,
  RegistryEntry,
  TransitionReason,
} from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { attachAgentRegistry } from "../agent-registry-bridge.js";
import { createSupervisor } from "../create-supervisor.js";
import { createFakeBackend } from "./fake-backend.js";

/**
 * Minimal in-test AgentRegistry — this package can't depend on
 * `@koi/engine-reconcile`'s `createInMemoryRegistry` at the source layer, so
 * the test owns a small stub with the fields the bridge touches (lookup +
 * transition). Keeps the test focused on the bridge's behavior, not the
 * registry implementation.
 */
function createStubAgentRegistry(): AgentRegistry & {
  readonly transitions: ReadonlyArray<{
    readonly id: string;
    readonly phase: ProcessState;
    readonly reason: TransitionReason;
  }>;
} {
  const entries = new Map<string, RegistryEntry>();
  const transitions: Array<{
    readonly id: string;
    readonly phase: ProcessState;
    readonly reason: TransitionReason;
  }> = [];
  const stub: AgentRegistry = {
    register: (entry: RegistryEntry) => {
      entries.set(entry.agentId, entry);
      return entry;
    },
    deregister: (id: AgentId) => entries.delete(id),
    lookup: (id: AgentId) => entries.get(id),
    list: () => Array.from(entries.values()),
    transition: (
      id: AgentId,
      targetPhase: ProcessState,
      expectedGeneration: number,
      reason: TransitionReason,
    ) => {
      const entry = entries.get(id);
      if (entry === undefined) {
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", message: `agent ${id} not found`, retryable: false },
        };
      }
      if (entry.status.generation !== expectedGeneration) {
        return {
          ok: false as const,
          error: { code: "CONFLICT", message: "generation mismatch", retryable: false },
        };
      }
      const next: RegistryEntry = {
        ...entry,
        status: {
          phase: targetPhase,
          generation: entry.status.generation + 1,
          conditions: [],
          reason,
          lastTransitionAt: Date.now(),
        },
      };
      entries.set(id, next);
      transitions.push({ id, phase: targetPhase, reason });
      return { ok: true as const, value: next };
    },
    patch: (id: AgentId, _fields: PatchableRegistryFields) => {
      const entry = entries.get(id);
      if (entry === undefined) {
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", message: `agent ${id} not found`, retryable: false },
        };
      }
      return { ok: true as const, value: entry };
    },
    watch: () => () => undefined,
    [Symbol.asyncDispose]: async () => {
      entries.clear();
    },
  };
  return Object.assign(stub, {
    get transitions(): ReadonlyArray<{
      readonly id: string;
      readonly phase: ProcessState;
      readonly reason: TransitionReason;
    }> {
      return transitions;
    },
  });
}

function registerInitial(registry: AgentRegistry, id: ReturnType<typeof agentId>): RegistryEntry {
  const entry = registry.register({
    agentId: id,
    status: {
      phase: "created",
      generation: 0,
      conditions: [],
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

describe("attachAgentRegistry", () => {
  it("mirrors started → running and exited → terminated for mapped workers", async () => {
    const { backend, exit } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createStubAgentRegistry();
    const agent = agentId("supervised-child-1");
    registerInitial(registry, agent);

    const bridge = attachAgentRegistry({ supervisor, agentRegistry: registry });
    const worker = workerId("w-1");
    bridge.mapWorker(worker, agent);

    await supervisor.start({ workerId: worker, agentId: agent, command: ["noop"] });
    // Give watchAll loop time to observe the `started` event.
    for (let i = 0; i < 50; i++) {
      if (registry.transitions.some((t) => t.phase === "running")) break;
      await Bun.sleep(5);
    }
    expect(registry.transitions.some((t) => t.phase === "running")).toBe(true);

    exit(worker, 0);
    for (let i = 0; i < 50; i++) {
      if (registry.transitions.some((t) => t.phase === "terminated")) break;
      await Bun.sleep(5);
    }
    const terminal = registry.transitions.find((t) => t.phase === "terminated");
    expect(terminal).toBeDefined();
    expect(terminal?.reason.kind).toBe("completed");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("classifies non-zero exit as error", async () => {
    const { backend, exit } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createStubAgentRegistry();
    const agent = agentId("supervised-child-exit-nonzero");
    registerInitial(registry, agent);

    const bridge = attachAgentRegistry({ supervisor, agentRegistry: registry });
    const worker = workerId("w-nonzero");
    bridge.mapWorker(worker, agent);

    await supervisor.start({ workerId: worker, agentId: agent, command: ["noop"] });
    exit(worker, 137);

    for (let i = 0; i < 50; i++) {
      if (registry.transitions.some((t) => t.phase === "terminated")) break;
      await Bun.sleep(5);
    }
    const terminal = registry.transitions.find((t) => t.phase === "terminated");
    expect(terminal?.reason.kind).toBe("error");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("surfaces NOT_FOUND when mapping references an unregistered agent", async () => {
    const { backend, exit } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createStubAgentRegistry();
    const errors: string[] = [];
    const bridge = attachAgentRegistry({
      supervisor,
      agentRegistry: registry,
      onError: (e) => {
        errors.push(e.code);
      },
    });

    // Intentionally skip registry.register — bridge should report NOT_FOUND.
    const worker = workerId("w-unregistered");
    bridge.mapWorker(worker, agentId("ghost-agent"));
    await supervisor.start({
      workerId: worker,
      agentId: agentId("ghost-agent"),
      command: ["noop"],
    });
    exit(worker, 0);

    for (let i = 0; i < 50; i++) {
      if (errors.includes("NOT_FOUND")) break;
      await Bun.sleep(5);
    }
    expect(errors).toContain("NOT_FOUND");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("ignores events for unmapped workerIds", async () => {
    const { backend, exit } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createStubAgentRegistry();
    const bridge = attachAgentRegistry({ supervisor, agentRegistry: registry });

    // No mapWorker call — bridge must stay silent.
    const worker = workerId("w-unmapped");
    await supervisor.start({
      workerId: worker,
      agentId: agentId("unrelated"),
      command: ["noop"],
    });
    exit(worker, 0);
    await Bun.sleep(50);
    expect(registry.transitions.length).toBe(0);

    await supervisor.shutdown("test-done");
    await bridge.close();
  });
});

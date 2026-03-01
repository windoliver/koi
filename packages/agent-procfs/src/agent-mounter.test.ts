/**
 * Tests for agent mounter — mount/unmount on registry events, churn simulation.
 */

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentId,
  AgentManifest,
  AgentRegistry,
  KoiError,
  PatchableRegistryFields,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  Result,
  SubsystemToken,
  TransitionReason,
} from "@koi/core";
import { agentId } from "@koi/core";
import { createAgentMounter } from "./agent-mounter.js";
import { createProcFs } from "./procfs-impl.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(id: AgentId): Agent {
  const pid = { id, name: `agent-${id}`, type: "worker" as const, depth: 0 };
  return {
    pid,
    manifest: { name: `agent-${id}`, description: "test" } as AgentManifest,
    state: "running",
    component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: () => new Map(),
  };
}

function createMockRegistry(): AgentRegistry & {
  readonly _emit: (event: RegistryEvent) => void;
} {
  let listeners: Array<(event: RegistryEvent) => void> = []; // let: mutable for watch/unwatch

  return {
    register: (e: RegistryEntry) => e,
    deregister: () => true,
    lookup: () => undefined,
    list: (_filter?: RegistryFilter) => [],
    transition: (
      _id: AgentId,
      _phase: ProcessState,
      _gen: number,
      _reason: TransitionReason,
    ): Result<RegistryEntry, KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "mock", retryable: false },
    }),
    patch: (_id: AgentId, _fields: PatchableRegistryFields): Result<RegistryEntry, KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "mock", retryable: false },
    }),
    watch: (listener: (event: RegistryEvent) => void) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    [Symbol.asyncDispose]: async () => {
      listeners = [];
    },
    _emit: (event: RegistryEvent) => {
      for (const l of listeners) l(event);
    },
  };
}

function mockEntry(id: string): RegistryEntry {
  return {
    agentId: agentId(id),
    status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentMounter", () => {
  test("mounts entries on register event", async () => {
    const registry = createMockRegistry();
    const procFs = createProcFs();
    const agents = new Map<string, Agent>();
    const id = agentId("a1");
    agents.set(id, createMockAgent(id));

    createAgentMounter({
      registry,
      procFs,
      agentProvider: (aid) => agents.get(aid as string),
    });

    registry._emit({ kind: "registered", entry: mockEntry("a1") });

    const entries = procFs.entries();
    expect(entries.length).toBeGreaterThanOrEqual(7);
    expect(entries).toContain("/agents/a1/status");
    expect(entries).toContain("/agents/a1/tools");
    expect(entries).toContain("/agents/a1/env");
  });

  test("unmounts entries on deregister event", () => {
    const registry = createMockRegistry();
    const procFs = createProcFs();
    const agents = new Map<string, Agent>();
    const id = agentId("a1");
    agents.set(id, createMockAgent(id));

    createAgentMounter({
      registry,
      procFs,
      agentProvider: (aid) => agents.get(aid as string),
    });

    registry._emit({ kind: "registered", entry: mockEntry("a1") });
    expect(procFs.entries().length).toBeGreaterThan(0);

    registry._emit({ kind: "deregistered", agentId: agentId("a1") });
    expect(procFs.entries().length).toBe(0);
  });

  test("read entry for deregistered agent returns undefined", async () => {
    const registry = createMockRegistry();
    const procFs = createProcFs();
    const agents = new Map<string, Agent>();
    const id = agentId("a1");
    agents.set(id, createMockAgent(id));

    createAgentMounter({
      registry,
      procFs,
      agentProvider: (aid) => agents.get(aid as string),
    });

    registry._emit({ kind: "registered", entry: mockEntry("a1") });
    registry._emit({ kind: "deregistered", agentId: agentId("a1") });

    const value = await procFs.read("/agents/a1/status");
    expect(value).toBeUndefined();
  });

  test("list /agents/ returns current agent IDs", async () => {
    const registry = createMockRegistry();
    const procFs = createProcFs();
    const agents = new Map<string, Agent>();

    for (const name of ["a1", "a2", "a3"]) {
      const id = agentId(name);
      agents.set(id, createMockAgent(id));
    }

    createAgentMounter({
      registry,
      procFs,
      agentProvider: (aid) => agents.get(aid as string),
    });

    registry._emit({ kind: "registered", entry: mockEntry("a1") });
    registry._emit({ kind: "registered", entry: mockEntry("a2") });
    registry._emit({ kind: "registered", entry: mockEntry("a3") });

    const children = await procFs.list("/agents");
    expect(children).toContain("a1");
    expect(children).toContain("a2");
    expect(children).toContain("a3");
  });

  test("churn simulation: register/deregister 10 agents while reading", async () => {
    const registry = createMockRegistry();
    const procFs = createProcFs();
    const agents = new Map<string, Agent>();

    createAgentMounter({
      registry,
      procFs,
      agentProvider: (aid) => agents.get(aid as string),
    });

    for (let i = 0; i < 10; i++) {
      const id = agentId(`churn-${i}`);
      agents.set(id, createMockAgent(id));
      registry._emit({ kind: "registered", entry: mockEntry(`churn-${i}`) });

      // Read while churning — should not crash
      await procFs.read(`/agents/churn-${i}/status`);
    }

    // Deregister all
    for (let i = 0; i < 10; i++) {
      registry._emit({ kind: "deregistered", agentId: agentId(`churn-${i}`) });
    }

    expect(procFs.entries().length).toBe(0);
  });

  test("dispose stops watching registry events", () => {
    const registry = createMockRegistry();
    const procFs = createProcFs();
    const agents = new Map<string, Agent>();
    const id = agentId("a1");
    agents.set(id, createMockAgent(id));

    const mounter = createAgentMounter({
      registry,
      procFs,
      agentProvider: (aid) => agents.get(aid as string),
    });

    mounter.dispose();

    // Events after dispose should not mount
    registry._emit({ kind: "registered", entry: mockEntry("a1") });
    expect(procFs.entries().length).toBe(0);
  });

  test("skips mount when agentProvider returns undefined", () => {
    const registry = createMockRegistry();
    const procFs = createProcFs();

    createAgentMounter({
      registry,
      procFs,
      agentProvider: () => undefined,
    });

    registry._emit({ kind: "registered", entry: mockEntry("missing") });
    expect(procFs.entries().length).toBe(0);
  });
});

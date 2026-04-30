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
import { ENTRY_NAMES } from "./entries/index.js";
import { createProcFs } from "./procfs-impl.js";

function createFakeAgent(id: AgentId): Agent {
  return {
    pid: { id, name: `agent-${id}`, type: "worker", depth: 0 },
    manifest: { name: `agent-${id}`, description: "test" } as AgentManifest,
    state: "running",
    component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: () => new Map(),
  };
}

interface FakeRegistry extends AgentRegistry {
  readonly _emit: (event: RegistryEvent) => void;
  readonly _seed: (entry: RegistryEntry) => void;
}

function createFakeRegistry(): FakeRegistry {
  let listeners: Array<(event: RegistryEvent) => void> = [];
  const seeded: RegistryEntry[] = [];

  const notFound: KoiError = { code: "NOT_FOUND", message: "mock", retryable: false };

  return {
    register: (e: RegistryEntry) => e,
    deregister: () => true,
    lookup: () => undefined,
    list: (_filter?: RegistryFilter) => [...seeded],
    transition: (
      _id: AgentId,
      _phase: ProcessState,
      _gen: number,
      _reason: TransitionReason,
    ): Result<RegistryEntry, KoiError> => ({ ok: false, error: notFound }),
    patch: (_id: AgentId, _fields: PatchableRegistryFields): Result<RegistryEntry, KoiError> => ({
      ok: false,
      error: notFound,
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
    _seed: (entry: RegistryEntry) => {
      seeded.push(entry);
    },
  };
}

function makeRegistryEntry(id: AgentId): RegistryEntry {
  return {
    agentId: id,
    agentType: "worker",
    priority: 0,
    registeredAt: Date.now(),
    status: { phase: "running", generation: 1, conditions: [] },
  } as unknown as RegistryEntry;
}

describe("createAgentMounter", () => {
  test("registered event mounts all 7 entries", async () => {
    const procFs = createProcFs({ cacheTtlMs: 0 });
    const registry = createFakeRegistry();
    const a1 = agentId("worker-1");
    const agentMap = new Map<AgentId, Agent>([[a1, createFakeAgent(a1)]]);
    createAgentMounter({
      registry,
      procFs,
      agentProvider: (id) => agentMap.get(id),
    });
    registry._emit({ kind: "registered", entry: makeRegistryEntry(a1) });
    const paths = procFs.entries();
    for (const name of ENTRY_NAMES) {
      expect(paths).toContain(`/agents/${a1}/${name}`);
    }
  });

  test("deregister event unmounts all 7 entries", async () => {
    const procFs = createProcFs({ cacheTtlMs: 0 });
    const registry = createFakeRegistry();
    const a1 = agentId("worker-2");
    const agentMap = new Map<AgentId, Agent>([[a1, createFakeAgent(a1)]]);
    createAgentMounter({
      registry,
      procFs,
      agentProvider: (id) => agentMap.get(id),
    });
    registry._emit({ kind: "registered", entry: makeRegistryEntry(a1) });
    expect(procFs.entries().length).toBe(ENTRY_NAMES.length);
    registry._emit({ kind: "deregistered", agentId: a1 });
    expect(procFs.entries().length).toBe(0);
  });

  test("skips mount when agentProvider returns undefined", async () => {
    const procFs = createProcFs({ cacheTtlMs: 0 });
    const registry = createFakeRegistry();
    const a1 = agentId("missing");
    createAgentMounter({
      registry,
      procFs,
      agentProvider: () => undefined,
    });
    registry._emit({ kind: "registered", entry: makeRegistryEntry(a1) });
    expect(procFs.entries().length).toBe(0);
  });

  test("churn: register/deregister 5 agents leaves no leaks", async () => {
    const procFs = createProcFs({ cacheTtlMs: 0 });
    const registry = createFakeRegistry();
    const agents = Array.from({ length: 5 }, (_, i) => agentId(`a-${i}`));
    const agentMap = new Map<AgentId, Agent>(
      agents.map((id) => [id, createFakeAgent(id)] as const),
    );
    createAgentMounter({
      registry,
      procFs,
      agentProvider: (id) => agentMap.get(id),
    });
    for (const id of agents) {
      registry._emit({ kind: "registered", entry: makeRegistryEntry(id) });
    }
    expect(procFs.entries().length).toBe(ENTRY_NAMES.length * agents.length);
    for (const id of agents) {
      registry._emit({ kind: "deregistered", agentId: id });
    }
    expect(procFs.entries().length).toBe(0);
  });

  test("dispose stops watching registry events", async () => {
    const procFs = createProcFs({ cacheTtlMs: 0 });
    const registry = createFakeRegistry();
    const a1 = agentId("disposed");
    const agentMap = new Map<AgentId, Agent>([[a1, createFakeAgent(a1)]]);
    const mounter = createAgentMounter({
      registry,
      procFs,
      agentProvider: (id) => agentMap.get(id),
    });
    mounter.dispose();
    registry._emit({ kind: "registered", entry: makeRegistryEntry(a1) });
    expect(procFs.entries().length).toBe(0);
  });

  test("retroactively mounts agents already in registry", async () => {
    const procFs = createProcFs({ cacheTtlMs: 0 });
    const registry = createFakeRegistry();
    const a1 = agentId("preexisting");
    registry._seed(makeRegistryEntry(a1));
    const agentMap = new Map<AgentId, Agent>([[a1, createFakeAgent(a1)]]);
    createAgentMounter({
      registry,
      procFs,
      agentProvider: (id) => agentMap.get(id),
    });
    // hydration is async — wait a microtask
    await Promise.resolve();
    expect(procFs.entries().length).toBe(ENTRY_NAMES.length);
  });

  test("transitioned and patched events do not affect mount state", async () => {
    const procFs = createProcFs({ cacheTtlMs: 0 });
    const registry = createFakeRegistry();
    const a1 = agentId("stable");
    const agentMap = new Map<AgentId, Agent>([[a1, createFakeAgent(a1)]]);
    createAgentMounter({
      registry,
      procFs,
      agentProvider: (id) => agentMap.get(id),
    });
    registry._emit({ kind: "registered", entry: makeRegistryEntry(a1) });
    const before = procFs.entries().length;
    registry._emit({
      kind: "transitioned",
      agentId: a1,
      from: "running",
      to: "terminated",
      generation: 2,
      reason: { kind: "completed" },
    });
    registry._emit({
      kind: "patched",
      agentId: a1,
      fields: { priority: 5 },
      entry: makeRegistryEntry(a1),
    });
    expect(procFs.entries().length).toBe(before);
  });
});

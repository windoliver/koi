import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentId,
  AgentManifest,
  AgentRegistry,
  KoiError,
  PatchableRegistryFields,
  RegistryEntry,
  RegistryFilter,
  Result,
} from "@koi/core";
import { agentId } from "@koi/core";
import { buildAgentEntries, ENTRY_NAMES } from "./index.js";

// Helper: Create a minimal fake Agent for testing
function createFakeAgent(id: AgentId): Agent {
  return {
    pid: {
      id,
      name: "test-agent",
      type: "copilot",
      depth: 0,
    },
    manifest: {
      name: "test-agent",
      description: "Test agent",
    } as AgentManifest,
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

// Helper: Create a minimal fake AgentRegistry for testing
function createFakeRegistry(): AgentRegistry {
  const entries = new Map<AgentId, RegistryEntry>();

  return {
    register: (entry) => {
      entries.set(entry.agentId, entry);
      return entry;
    },
    deregister: (id) => entries.delete(id),
    lookup: (id) => entries.get(id),
    list: (filter?: RegistryFilter) => {
      const all = [...entries.values()];
      if (!filter) return all;
      return all.filter((entry) => {
        if (filter.phase !== undefined && entry.status.phase !== filter.phase) return false;
        if (filter.parentId !== undefined && entry.parentId !== filter.parentId) return false;
        return true;
      });
    },
    transition: () => {
      const first = entries.values().next().value as RegistryEntry | undefined;
      if (!first) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Not found",
            retryable: false,
            context: {},
          } as KoiError,
        } as Result<RegistryEntry, KoiError>;
      }
      return { ok: true, value: first } as Result<RegistryEntry, KoiError>;
    },
    patch: (agentId: AgentId, fields: PatchableRegistryFields) => {
      const current = entries.get(agentId);
      if (!current) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Not found",
            retryable: false,
            context: {},
          } as KoiError,
        } as Result<RegistryEntry, KoiError>;
      }
      if (fields.priority !== undefined) {
        const updated = { ...current, priority: fields.priority };
        entries.set(agentId, updated);
        return { ok: true, value: updated } as Result<RegistryEntry, KoiError>;
      }
      return { ok: true, value: current } as Result<RegistryEntry, KoiError>;
    },
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

describe("entries/index", () => {
  test("ENTRY_NAMES has 7 entries", () => {
    expect(ENTRY_NAMES.length).toBe(7);
  });

  test("buildAgentEntries returns all 7 entries by name", () => {
    const agent = createFakeAgent(agentId("agent-1"));
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);

    expect(Object.keys(entries).length).toBe(7);
    expect(entries).toHaveProperty("status");
    expect(entries).toHaveProperty("tools");
    expect(entries).toHaveProperty("middleware");
    expect(entries).toHaveProperty("children");
    expect(entries).toHaveProperty("config");
    expect(entries).toHaveProperty("env");
    expect(entries).toHaveProperty("metrics");
  });

  test("statusEntry reads agent pid, state, and terminationOutcome", async () => {
    const id = agentId("agent-status");
    const agent = createFakeAgent(id);
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.status.read();

    expect(result).toEqual({
      pid: agent.pid,
      state: "running",
      terminationOutcome: undefined,
    });
  });

  test("toolsEntry returns empty array when no tools attached", async () => {
    const agent = createFakeAgent(agentId("agent-tools"));
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.tools.read();

    expect(result).toEqual([]);
  });

  test("middlewareEntry returns empty array when no middleware attached", async () => {
    const agent = createFakeAgent(agentId("agent-mw"));
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.middleware.read();

    expect(result).toEqual([]);
  });

  test("childrenEntry returns empty array when no children", async () => {
    const parentId = agentId("parent");
    const agent = createFakeAgent(parentId);
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.children.read();

    expect(result).toEqual([]);
  });

  test("childrenEntry returns child IDs when children exist", async () => {
    const parentId = agentId("parent");
    const childId1 = agentId("child-1");
    const childId2 = agentId("child-2");

    const agent = createFakeAgent(parentId);
    const registry = createFakeRegistry();

    // Register children
    const now = Date.now();
    const childEntry1: RegistryEntry = {
      agentId: childId1,
      status: {
        phase: "running",
        generation: 1,
        conditions: [],
        lastTransitionAt: now,
      },
      agentType: "worker",
      metadata: {},
      registeredAt: now,
      parentId,
      priority: 10,
    };
    const childEntry2: RegistryEntry = {
      agentId: childId2,
      status: {
        phase: "running",
        generation: 1,
        conditions: [],
        lastTransitionAt: now,
      },
      agentType: "worker",
      metadata: {},
      registeredAt: now,
      parentId,
      priority: 10,
    };

    registry.register(childEntry1);
    registry.register(childEntry2);

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.children.read();

    expect(Array.isArray(result)).toBe(true);
    const items = result as unknown[];
    expect(items.length).toBe(2);
  });

  test("configEntry reads manifest name, description, model, and lifecycle", async () => {
    const agent = createFakeAgent(agentId("agent-config"));
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.config.read();

    expect(result).toEqual({
      name: "test-agent",
      description: "Test agent",
      model: undefined,
      lifecycle: undefined,
    });
  });

  test("envEntry returns empty object when no ENV component", async () => {
    const agent = createFakeAgent(agentId("agent-env"));
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.env.read();

    expect(result).toEqual({});
  });

  test("metricsEntry reads priority from registry", async () => {
    const id = agentId("agent-metrics");
    const agent = createFakeAgent(id);
    const registry = createFakeRegistry();

    const now = Date.now();
    const entry: RegistryEntry = {
      agentId: id,
      status: {
        phase: "running",
        generation: 5,
        conditions: [],
        lastTransitionAt: now,
      },
      agentType: "copilot",
      metadata: {},
      registeredAt: now,
      priority: 15,
    };
    registry.register(entry);

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.metrics.read();

    expect(result).toEqual({
      priority: 15,
      generation: 5,
      phase: "running",
      conditions: [],
      registeredAt: now,
    });
  });

  test("metricsEntry is writable", async () => {
    const id = agentId("agent-metrics-write");
    const agent = createFakeAgent(id);
    const registry = createFakeRegistry();

    const now = Date.now();
    const entry: RegistryEntry = {
      agentId: id,
      status: {
        phase: "running",
        generation: 1,
        conditions: [],
        lastTransitionAt: now,
      },
      agentType: "copilot",
      metadata: {},
      registeredAt: now,
      priority: 10,
    };
    registry.register(entry);

    const entries = buildAgentEntries(agent, registry);
    expect(entries.metrics).toHaveProperty("write");

    const metricsWritable = entries.metrics as { write(value: unknown): Promise<void> };
    await metricsWritable.write({ priority: 25 });

    // Verify the patch was applied
    const updated = await entries.metrics.read();
    const updatedMetrics = updated as { priority: number } | undefined;
    expect(updatedMetrics?.priority).toBe(25);
  });

  test("metricsEntry write throws on missing priority", async () => {
    const id = agentId("agent-metrics-invalid");
    const agent = createFakeAgent(id);
    const registry = createFakeRegistry();

    const now = Date.now();
    const entry: RegistryEntry = {
      agentId: id,
      status: {
        phase: "running",
        generation: 1,
        conditions: [],
        lastTransitionAt: now,
      },
      agentType: "copilot",
      metadata: {},
      registeredAt: now,
      priority: 10,
    };
    registry.register(entry);

    const entries = buildAgentEntries(agent, registry);
    const metricsWritable = entries.metrics as { write(value: unknown): Promise<void> };

    try {
      await metricsWritable.write({});
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toMatch(/VALIDATION:/);
    }
  });

  test("metricsEntry write throws on wrong priority type", async () => {
    const id = agentId("agent-metrics-wrong-type");
    const agent = createFakeAgent(id);
    const registry = createFakeRegistry();

    const now = Date.now();
    const entry: RegistryEntry = {
      agentId: id,
      status: {
        phase: "running",
        generation: 1,
        conditions: [],
        lastTransitionAt: now,
      },
      agentType: "copilot",
      metadata: {},
      registeredAt: now,
      priority: 10,
    };
    registry.register(entry);

    const entries = buildAgentEntries(agent, registry);
    const metricsWritable = entries.metrics as { write(value: unknown): Promise<void> };

    try {
      await metricsWritable.write({ priority: "not a number" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toMatch(/VALIDATION:/);
    }
  });

  test("metricsEntry write propagates patch failure", async () => {
    const id = agentId("agent-metrics-patch-fail");
    const agent = createFakeAgent(id);

    // Create a registry that returns error on patch
    const registry: AgentRegistry = {
      register: () => ({
        agentId: id,
        status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: 0 },
        agentType: "copilot",
        metadata: {},
        registeredAt: 0,
        priority: 10,
      }),
      deregister: () => true,
      lookup: async () => ({
        agentId: id,
        status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: 0 },
        agentType: "copilot",
        metadata: {},
        registeredAt: 0,
        priority: 10,
      }),
      list: async () => [],
      transition: async () => ({
        ok: true,
        value: {
          agentId: id,
          status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: 0 },
          agentType: "copilot",
          metadata: {},
          registeredAt: 0,
          priority: 10,
        },
      }),
      patch: async () =>
        ({
          ok: false,
          error: { code: "CONFLICT", message: "Conflict", retryable: true, context: {} },
        }) as Result<RegistryEntry, KoiError>,
      watch: () => () => {},
      [Symbol.asyncDispose]: async () => {},
    };

    const entries = buildAgentEntries(agent, registry);
    const metricsWritable = entries.metrics as { write(value: unknown): Promise<void> };

    try {
      await metricsWritable.write({ priority: 20 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toMatch(/patch failed:/);
    }
  });

  test("metricsEntry read returns undefined when agent not found", async () => {
    const id = agentId("agent-not-found");
    const agent = createFakeAgent(id);
    const registry = createFakeRegistry();

    const entries = buildAgentEntries(agent, registry);
    const result = await entries.metrics.read();

    expect(result).toBeUndefined();
  });
});

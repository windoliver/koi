import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core/ecs";
import { agentId } from "@koi/core/ecs";
import type { AgentRegistry, RegistryEntry, RegistryFilter } from "@koi/core/lifecycle";
import { createRegistryAgentResolver } from "./registry-agent-resolver.js";
import type { TaskableAgent, TaskableAgentSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockManifest(): {
  readonly name: string;
  readonly version: string;
  readonly model: { readonly name: string };
} {
  return { name: "test-agent", version: "0.1.0", model: { name: "test-model" } };
}

function createTaskableAgent(name: string, description: string): TaskableAgent {
  return { name, description, manifest: createMockManifest() };
}

function createRegistryEntry(
  id: string,
  phase: "created" | "running" | "waiting" | "suspended" | "terminated",
  agentType: "copilot" | "worker" = "copilot",
  conditions: readonly ("Initialized" | "Ready" | "Healthy" | "Draining" | "BackgroundWork")[] = [],
): RegistryEntry {
  return {
    agentId: agentId(id),
    agentType,
    status: {
      phase,
      generation: 1,
      conditions,
      lastTransitionAt: Date.now(),
    },
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
  };
}

function createMockRegistry(entries: readonly RegistryEntry[]): AgentRegistry {
  return {
    register: async (e: RegistryEntry) => e,
    deregister: async () => true,
    lookup: async (id: AgentId) => entries.find((e) => e.agentId === id),
    list: async (filter?: RegistryFilter) => {
      return entries.filter((e) => {
        if (filter?.agentType !== undefined && e.agentType !== filter.agentType) return false;
        if (filter?.phase !== undefined && e.status.phase !== filter.phase) return false;
        return true;
      });
    },
    transition: async () => {
      const entry = entries[0];
      if (entry === undefined) throw new Error("no entries");
      return { ok: true as const, value: entry };
    },
    patch: async () => {
      const entry = entries[0];
      if (entry === undefined) throw new Error("no entries");
      return { ok: true as const, value: entry };
    },
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  } as unknown as AgentRegistry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRegistryAgentResolver", () => {
  const catalog = new Map<string, TaskableAgent>([
    ["researcher", createTaskableAgent("Researcher", "Does research")],
    ["coder", createTaskableAgent("Coder", "Writes code")],
  ]);

  test("resolve returns ok result when catalog has matching entry", async () => {
    const registry = createMockRegistry([]);
    const resolver = createRegistryAgentResolver(catalog, registry);

    const result = await resolver.resolve("researcher");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Researcher");
    }
  });

  test("resolve returns error result when no match", async () => {
    const registry = createMockRegistry([]);
    const resolver = createRegistryAgentResolver(catalog, registry);

    const result = await resolver.resolve("nonexistent");
    expect(result.ok).toBe(false);
  });

  test("list returns summaries from catalog", async () => {
    const registry = createMockRegistry([]);
    const resolver = createRegistryAgentResolver(catalog, registry);

    const summaries = await resolver.list();
    expect(summaries).toHaveLength(2);
    const keys = (summaries as readonly TaskableAgentSummary[]).map((s) => s.key);
    expect(keys).toContain("researcher");
    expect(keys).toContain("coder");
  });

  test("list returns empty array when catalog is empty", async () => {
    const registry = createMockRegistry([]);
    const resolver = createRegistryAgentResolver(new Map(), registry);

    const summaries = await resolver.list();
    expect(summaries).toHaveLength(0);
  });

  test("findLive returns idle state for waiting+Ready agent", async () => {
    const registry = createMockRegistry([
      createRegistryEntry("agent-1", "waiting", "copilot", ["Ready"]),
    ]);
    const resolver = createRegistryAgentResolver(catalog, registry);

    const handle = await resolver.findLive?.("copilot");
    expect(handle).toBeDefined();
    expect(handle?.state).toBe("idle");
    expect(handle?.agentId).toBe(agentId("agent-1"));
  });

  test("findLive returns busy state for running agent without idle agents", async () => {
    const registry = createMockRegistry([createRegistryEntry("agent-2", "running", "copilot")]);
    const resolver = createRegistryAgentResolver(catalog, registry);

    const handle = await resolver.findLive?.("copilot");
    expect(handle).toBeDefined();
    expect(handle?.state).toBe("busy");
  });

  test("findLive returns undefined when no running agents of that type", async () => {
    const registry = createMockRegistry([createRegistryEntry("agent-3", "running", "worker")]);
    const resolver = createRegistryAgentResolver(catalog, registry);

    // Looking for copilot, but only worker is running
    const handle = await resolver.findLive?.("copilot");
    expect(handle).toBeUndefined();
  });

  test("findLive returns undefined for suspended/terminated agents", async () => {
    const registry = createMockRegistry([
      createRegistryEntry("agent-4", "suspended", "copilot"),
      createRegistryEntry("agent-5", "terminated", "copilot"),
    ]);
    const resolver = createRegistryAgentResolver(catalog, registry);

    const handle = await resolver.findLive?.("copilot");
    expect(handle).toBeUndefined();
  });
});

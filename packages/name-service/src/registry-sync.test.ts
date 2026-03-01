import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentId, AgentRegistry, NameServiceBackend, RegistryEvent } from "@koi/core";
import { createInMemoryNameService } from "./in-memory-backend.js";
import { createRegistrySync } from "./registry-sync.js";

/** Minimal mock AgentRegistry that only implements watch(). */
function createMockRegistry(): {
  readonly registry: AgentRegistry;
  readonly emit: (event: RegistryEvent) => void;
} {
  const listeners: Array<(event: RegistryEvent) => void> = [];

  const registry = {
    watch: (listener: (event: RegistryEvent) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    // Stubs for required AgentRegistry methods (not used by sync)
    register: () => {
      throw new Error("not implemented");
    },
    deregister: () => {
      throw new Error("not implemented");
    },
    lookup: () => {
      throw new Error("not implemented");
    },
    list: () => {
      throw new Error("not implemented");
    },
    transition: () => {
      throw new Error("not implemented");
    },
    [Symbol.asyncDispose]: async () => {},
  } as unknown as AgentRegistry;

  const emit = (event: RegistryEvent): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  return { registry, emit };
}

describe("createRegistrySync", () => {
  let ns: NameServiceBackend;
  let mockRegistry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    ns = createInMemoryNameService({ defaultTtlMs: 0 });
    mockRegistry = createMockRegistry();
  });

  afterEach(() => {
    ns.dispose?.();
  });

  test("registers agent name on registry 'registered' event", async () => {
    createRegistrySync(mockRegistry.registry, ns);

    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a1" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "reviewer" },
        registeredAt: Date.now(),
      },
    });

    const result = await ns.resolve("reviewer");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.binding).toEqual({ kind: "agent", agentId: "a1" as AgentId });
    }
  });

  test("falls back to agentId when metadata.name is missing", async () => {
    createRegistrySync(mockRegistry.registry, ns);

    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a1" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: {},
        registeredAt: Date.now(),
      },
    });

    const result = await ns.resolve("a1");
    expect(result.ok).toBe(true);
  });

  test("unregisters agent name on registry 'deregistered' event", async () => {
    createRegistrySync(mockRegistry.registry, ns);

    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a1" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "reviewer" },
        registeredAt: Date.now(),
      },
    });

    // Verify registered
    expect((await ns.resolve("reviewer")).ok).toBe(true);

    mockRegistry.emit({
      kind: "deregistered",
      agentId: "a1" as AgentId,
    });

    // Verify unregistered
    expect((await ns.resolve("reviewer")).ok).toBe(false);
  });

  test("handles multiple events in sequence", async () => {
    createRegistrySync(mockRegistry.registry, ns);

    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a1" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "alpha" },
        registeredAt: Date.now(),
      },
    });

    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a2" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "beta" },
        registeredAt: Date.now(),
      },
    });

    expect((await ns.resolve("alpha")).ok).toBe(true);
    expect((await ns.resolve("beta")).ok).toBe(true);

    mockRegistry.emit({ kind: "deregistered", agentId: "a1" as AgentId });

    expect((await ns.resolve("alpha")).ok).toBe(false);
    expect((await ns.resolve("beta")).ok).toBe(true);
  });

  test("unsubscribe stops sync", async () => {
    const unsub = createRegistrySync(mockRegistry.registry, ns);

    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a1" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "reviewer" },
        registeredAt: Date.now(),
      },
    });

    expect((await ns.resolve("reviewer")).ok).toBe(true);

    unsub();

    // New events should not be synced
    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a2" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "planner" },
        registeredAt: Date.now(),
      },
    });

    expect((await ns.resolve("planner")).ok).toBe(false);
  });

  test("uses custom scope from config", async () => {
    createRegistrySync(mockRegistry.registry, ns, { defaultScope: "global" });

    mockRegistry.emit({
      kind: "registered",
      entry: {
        agentId: "a1" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "reviewer" },
        registeredAt: Date.now(),
      },
    });

    // Should not resolve in agent scope
    expect((await ns.resolve("reviewer", "agent")).ok).toBe(false);
    // Should resolve in global scope
    expect((await ns.resolve("reviewer", "global")).ok).toBe(true);
  });

  test("ignores 'transitioned' events", async () => {
    createRegistrySync(mockRegistry.registry, ns);

    // This should not throw or cause issues
    mockRegistry.emit({
      kind: "transitioned",
      agentId: "a1" as AgentId,
      from: "created",
      to: "running",
      generation: 1,
      reason: { kind: "assembly_complete" },
    });

    // No names registered
    const results = await ns.search({});
    expect(results.length).toBe(0);
  });
});

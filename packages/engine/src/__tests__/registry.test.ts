import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProcessState, RegistryEntry, RegistryEvent } from "@koi/core";
import { agentId } from "@koi/core";
import { runAgentRegistryContractTests } from "@koi/test-utils";
import type { InMemoryRegistry } from "../registry.js";
import { createInMemoryRegistry } from "../registry.js";

// ---------------------------------------------------------------------------
// Shared contract suite
// ---------------------------------------------------------------------------

runAgentRegistryContractTests(() => createInMemoryRegistry());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(id: string, phase: ProcessState = "created", generation = 0): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemoryRegistry", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  // --- Register ---

  test("register stores and returns entry", () => {
    const e = entry("agent-1");
    const stored = registry.register(e);
    expect(stored).toEqual(e);
  });

  test("register duplicate agentId overwrites", () => {
    registry.register(entry("agent-1", "created"));
    const updated = entry("agent-1", "running", 1);
    const stored = registry.register(updated);
    expect(stored.status.phase).toBe("running");
  });

  // --- Lookup ---

  test("lookup returns registered entry", () => {
    registry.register(entry("agent-1"));
    const found = registry.lookup(agentId("agent-1"));
    expect(found).toBeDefined();
    expect(found?.agentId).toBe(agentId("agent-1"));
  });

  test("lookup returns undefined for unknown agent", () => {
    const found = registry.lookup(agentId("ghost"));
    expect(found).toBeUndefined();
  });

  // --- Deregister ---

  test("deregister removes agent and returns true", () => {
    registry.register(entry("agent-1"));
    const removed = registry.deregister(agentId("agent-1"));
    expect(removed).toBe(true);
    expect(registry.lookup(agentId("agent-1"))).toBeUndefined();
  });

  test("deregister returns false for unknown agent", () => {
    expect(registry.deregister(agentId("ghost"))).toBe(false);
  });

  // --- List ---

  test("list returns all agents when no filter", () => {
    registry.register(entry("a1"));
    registry.register(entry("a2"));
    registry.register(entry("a3"));
    const all = registry.list();
    expect(all).toHaveLength(3);
  });

  test("list filters by phase", () => {
    registry.register(entry("a1", "created"));
    registry.register(entry("a2", "running", 1));
    registry.register(entry("a3", "running", 1));

    const running = registry.list({ phase: "running" });
    expect(running).toHaveLength(2);
    expect(running.every((e) => e.status.phase === "running")).toBe(true);
  });

  test("list filters by agentType", () => {
    registry.register({ ...entry("a1"), agentType: "copilot" });
    registry.register({ ...entry("a2"), agentType: "worker" });

    const copilots = registry.list({ agentType: "copilot" });
    expect(copilots).toHaveLength(1);
    expect(copilots[0]?.agentType).toBe("copilot");
  });

  test("list filters by condition", () => {
    registry.register({
      ...entry("a1"),
      status: {
        phase: "running",
        generation: 1,
        conditions: ["Ready", "Healthy"],
        lastTransitionAt: 0,
      },
    });
    registry.register({
      ...entry("a2"),
      status: { phase: "running", generation: 1, conditions: ["Ready"], lastTransitionAt: 0 },
    });
    registry.register({
      ...entry("a3"),
      status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: 0 },
    });

    const healthy = registry.list({ condition: "Healthy" });
    expect(healthy).toHaveLength(1);
    expect(healthy[0]?.agentId).toBe(agentId("a1"));
  });

  test("list filters by parentId", () => {
    registry.register(entry("root"));
    registry.register({ ...entry("child-1"), parentId: agentId("root") });
    registry.register({ ...entry("child-2"), parentId: agentId("root") });
    registry.register({ ...entry("other"), parentId: agentId("other-root") });

    const children = registry.list({ parentId: agentId("root") });
    expect(children).toHaveLength(2);
    expect(children.every((e) => e.parentId === agentId("root"))).toBe(true);
  });

  // --- Transition (CAS) ---

  test("transition with correct generation succeeds", () => {
    registry.register(entry("a1", "created", 0));
    const result = registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status.phase).toBe("running");
      expect(result.value.status.generation).toBe(1);
    }
  });

  test("transition with stale generation returns CONFLICT", () => {
    registry.register(entry("a1", "running", 5));
    const result = registry.transition(
      agentId("a1"),
      "waiting",
      3, // stale
      { kind: "awaiting_response" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  test("transition on unknown agent returns NOT_FOUND", () => {
    const result = registry.transition(agentId("ghost"), "running", 0, {
      kind: "assembly_complete",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("invalid transition returns VALIDATION error", () => {
    registry.register(entry("a1", "created", 0));
    const result = registry.transition(
      agentId("a1"),
      "waiting", // created → waiting is not allowed
      0,
      { kind: "awaiting_response" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  // --- CAS contention ---

  test("concurrent transitions: only one succeeds (CAS contention)", () => {
    registry.register(entry("a1", "running", 3));

    // Two concurrent transitions both expecting generation 3
    const r1 = registry.transition(agentId("a1"), "waiting", 3, { kind: "awaiting_response" });
    const r2 = registry.transition(agentId("a1"), "suspended", 3, { kind: "hitl_pause" });

    // Exactly one should succeed, the other should CONFLICT
    const results = [r1, r2];
    const successes = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    if (!conflicts[0]?.ok && conflicts[0]) {
      expect(conflicts[0].error.code).toBe("CONFLICT");
    }
  });

  // --- Watch ---

  test("watch fires on register", () => {
    const events: RegistryEvent[] = [];
    registry.watch((event) => events.push(event));

    registry.register(entry("a1"));

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("registered");
  });

  test("watch fires on deregister", () => {
    registry.register(entry("a1"));

    const events: RegistryEvent[] = [];
    registry.watch((event) => events.push(event));

    registry.deregister(agentId("a1"));

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("deregistered");
    if (events[0]?.kind === "deregistered") {
      expect(events[0].agentId).toBe(agentId("a1"));
    }
  });

  test("watch fires on successful transition", () => {
    registry.register(entry("a1", "created", 0));

    const events: RegistryEvent[] = [];
    registry.watch((event) => events.push(event));

    registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("transitioned");
    if (events[0]?.kind === "transitioned") {
      expect(events[0].from).toBe("created");
      expect(events[0].to).toBe("running");
      expect(events[0].generation).toBe(1);
      expect(events[0].reason).toEqual({ kind: "assembly_complete" });
    }
  });

  test("watch does NOT fire on failed transition", () => {
    registry.register(entry("a1", "created", 0));

    const events: RegistryEvent[] = [];
    registry.watch((event) => events.push(event));

    // Invalid transition (created → waiting is not allowed)
    registry.transition(agentId("a1"), "waiting", 0, { kind: "awaiting_response" });

    expect(events).toHaveLength(0);
  });

  test("unsubscribe stops notifications", () => {
    const events: RegistryEvent[] = [];
    const unsub = registry.watch((event) => events.push(event));

    registry.register(entry("a1"));
    expect(events).toHaveLength(1);

    unsub();

    registry.register(entry("a2"));
    expect(events).toHaveLength(1); // no new event
  });

  // --- Dispose ---

  test("dispose clears all entries", async () => {
    registry.register(entry("a1"));
    registry.register(entry("a2"));

    await registry[Symbol.asyncDispose]();

    expect(registry.list()).toHaveLength(0);
  });
});

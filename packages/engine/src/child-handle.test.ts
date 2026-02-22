import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildLifecycleEvent, ProcessState, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import { createChildHandle } from "./child-handle.js";
import type { InMemoryRegistry } from "./registry.js";
import { createInMemoryRegistry } from "./registry.js";

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
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChildHandle", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("fires started event on created → running", () => {
    registry.register(entry("child-1", "created", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    registry.transition(agentId("child-1"), "running", 0, { kind: "assembly_complete" });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("started");
    expect(events[0]?.childId).toBe(agentId("child-1"));
  });

  test("fires terminated event on transition to terminated", () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    registry.transition(agentId("child-1"), "terminated", 0, { kind: "completed" });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("terminated");
  });

  test("fires terminated on deregister", () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    registry.deregister(agentId("child-1"));

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("terminated");
  });

  test("unsubscribe stops event delivery", () => {
    registry.register(entry("child-1", "created", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    const unsub = handle.onEvent((e) => events.push(e));

    unsub();

    registry.transition(agentId("child-1"), "running", 0, { kind: "assembly_complete" });

    expect(events).toHaveLength(0);
  });

  test("auto-cleans up registry watcher after termination", () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    // Terminate — should auto-cleanup
    registry.transition(agentId("child-1"), "terminated", 0, { kind: "completed" });
    expect(events).toHaveLength(1);

    // Register a new agent with the same ID — handle should NOT react
    registry.register(entry("child-1", "created", 0));
    registry.transition(agentId("child-1"), "running", 0, { kind: "assembly_complete" });
    expect(events).toHaveLength(1); // still 1, not 2
  });
});

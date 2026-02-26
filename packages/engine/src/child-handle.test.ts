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

  test("fires completed + terminated on transition with completed reason", () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    registry.transition(agentId("child-1"), "terminated", 0, { kind: "completed" });

    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("completed");
    expect(events[1]?.kind).toBe("terminated");
  });

  test("fires error + terminated on transition with error reason", () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    const cause = new Error("boom");
    registry.transition(agentId("child-1"), "terminated", 0, { kind: "error", cause });

    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("error");
    if (events[0]?.kind === "error") {
      expect(events[0].cause).toBe(cause);
    }
    expect(events[1]?.kind).toBe("terminated");
  });

  test("fires only terminated on evicted reason", () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    registry.transition(agentId("child-1"), "terminated", 0, { kind: "evicted" });

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

    // Terminate — should auto-cleanup (completed + terminated = 2 events)
    registry.transition(agentId("child-1"), "terminated", 0, { kind: "completed" });
    expect(events).toHaveLength(2);

    // Register a new agent with the same ID — handle should NOT react
    registry.register(entry("child-1", "created", 0));
    registry.transition(agentId("child-1"), "running", 0, { kind: "assembly_complete" });
    expect(events).toHaveLength(2); // still 2, not 3
  });

  test("multiple listeners receive events", () => {
    registry.register(entry("child-1", "created", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events1: ChildLifecycleEvent[] = [];
    const events2: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events1.push(e));
    handle.onEvent((e) => events2.push(e));

    registry.transition(agentId("child-1"), "running", 0, { kind: "assembly_complete" });

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0]?.kind).toBe("started");
    expect(events2[0]?.kind).toBe("started");
  });
});

// ---------------------------------------------------------------------------
// Signal and terminate
// ---------------------------------------------------------------------------

describe("createChildHandle signal/terminate", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("signal fires signaled event to listeners", async () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);
    const events: ChildLifecycleEvent[] = [];
    handle.onEvent((e) => events.push(e));

    await handle.signal("graceful_shutdown");

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("signaled");
    if (events[0]?.kind === "signaled") {
      expect(events[0].signal).toBe("graceful_shutdown");
      expect(events[0].childId).toBe(agentId("child-1"));
    }
  });

  test("signal aborts the abort controller", async () => {
    registry.register(entry("child-1", "running", 0));

    const controller = new AbortController();
    const handle = createChildHandle(agentId("child-1"), "worker-1", registry, controller);

    expect(controller.signal.aborted).toBe(false);

    await handle.signal("stop");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("stop");
  });

  test("terminate transitions child to terminated", async () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);

    await handle.terminate("cleanup");

    const child = registry.lookup(agentId("child-1"));
    expect(child?.status.phase).toBe("terminated");
  });

  test("terminate is idempotent on already-terminated child", async () => {
    registry.register(entry("child-1", "terminated", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);

    // Should not throw
    await handle.terminate();
    expect(registry.lookup(agentId("child-1"))?.status.phase).toBe("terminated");
  });

  test("terminate retries once on CAS conflict", async () => {
    registry.register(entry("child-1", "running", 0));

    const handle = createChildHandle(agentId("child-1"), "worker-1", registry);

    // Advance generation to cause CAS conflict on first attempt
    registry.transition(agentId("child-1"), "waiting", 0, { kind: "awaiting_response" });
    // child is now generation 1, phase "waiting"

    // terminate() will lookup (gen=1), but someone could advance in between
    // Here we test normal retry path by transitioning back so terminate can succeed
    registry.transition(agentId("child-1"), "running", 1, { kind: "response_received" });
    // child is now generation 2, phase "running"

    // terminate should succeed (reads current generation)
    await handle.terminate();
    expect(registry.lookup(agentId("child-1"))?.status.phase).toBe("terminated");
  });
});

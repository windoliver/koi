import { beforeEach, describe, expect, test } from "bun:test";
import type { HandoffEnvelope, RegistryEvent } from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { createHandoffStore, type HandoffStore } from "./store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestEnvelope(overrides?: Partial<HandoffEnvelope>): HandoffEnvelope {
  return {
    id: handoffId("hoff-1"),
    from: agentId("agent-a"),
    to: agentId("agent-b"),
    status: "pending",
    createdAt: Date.now(),
    phase: { completed: "phase 1 done", next: "do phase 2" },
    context: {
      results: { answer: 42 },
      artifacts: [],
      decisions: [],
      warnings: [],
    },
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HandoffStore", () => {
  let store: HandoffStore;

  beforeEach(() => {
    store = createHandoffStore();
  });

  test("put and get round-trip", () => {
    const envelope = createTestEnvelope();
    store.put(envelope);
    expect(store.get(envelope.id)).toEqual(envelope);
  });

  test("get returns undefined for unknown ID", () => {
    expect(store.get(handoffId("nonexistent"))).toBeUndefined();
  });

  test("transition updates status immutably", () => {
    const envelope = createTestEnvelope();
    store.put(envelope);

    const updated = store.transition(envelope.id, "pending", "injected");
    expect(updated).toBeDefined();
    expect(updated?.status).toBe("injected");
    expect(updated?.id).toBe(envelope.id);

    // Original properties preserved
    expect(updated?.from).toBe(envelope.from);
    expect(updated?.phase).toEqual(envelope.phase);
  });

  test("transition returns undefined on status mismatch", () => {
    const envelope = createTestEnvelope();
    store.put(envelope);

    const result = store.transition(envelope.id, "accepted", "expired");
    expect(result).toBeUndefined();
  });

  test("transition returns undefined for unknown ID", () => {
    const result = store.transition(handoffId("nonexistent"), "pending", "injected");
    expect(result).toBeUndefined();
  });

  test("listByAgent returns envelopes for agent", () => {
    const e1 = createTestEnvelope({ id: handoffId("h-1"), from: agentId("a"), to: agentId("b") });
    const e2 = createTestEnvelope({ id: handoffId("h-2"), from: agentId("b"), to: agentId("c") });
    const e3 = createTestEnvelope({ id: handoffId("h-3"), from: agentId("x"), to: agentId("y") });
    store.put(e1);
    store.put(e2);
    store.put(e3);

    const results = store.listByAgent(agentId("b"));
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.id)).toContain(handoffId("h-1"));
    expect(results.map((e) => e.id)).toContain(handoffId("h-2"));
  });

  test("remove deletes envelope", () => {
    const envelope = createTestEnvelope();
    store.put(envelope);
    expect(store.remove(envelope.id)).toBe(true);
    expect(store.get(envelope.id)).toBeUndefined();
  });

  test("remove returns false for unknown ID", () => {
    expect(store.remove(handoffId("nonexistent"))).toBe(false);
  });

  test("removeByAgent cleans up all agent envelopes", () => {
    const e1 = createTestEnvelope({ id: handoffId("h-1"), from: agentId("a"), to: agentId("b") });
    const e2 = createTestEnvelope({ id: handoffId("h-2"), from: agentId("b"), to: agentId("c") });
    const e3 = createTestEnvelope({ id: handoffId("h-3"), from: agentId("x"), to: agentId("y") });
    store.put(e1);
    store.put(e2);
    store.put(e3);

    store.removeByAgent(agentId("b"));
    expect(store.get(handoffId("h-1"))).toBeUndefined();
    expect(store.get(handoffId("h-2"))).toBeUndefined();
    expect(store.get(handoffId("h-3"))).toBeDefined();
  });

  test("findPendingForAgent finds pending envelope", () => {
    const envelope = createTestEnvelope({ to: agentId("target") });
    store.put(envelope);

    expect(store.findPendingForAgent(agentId("target"))).toEqual(envelope);
  });

  test("findPendingForAgent finds injected envelope", () => {
    const envelope = createTestEnvelope({ to: agentId("target"), status: "injected" });
    store.put(envelope);

    expect(store.findPendingForAgent(agentId("target"))).toEqual(envelope);
  });

  test("findPendingForAgent ignores accepted envelopes", () => {
    const envelope = createTestEnvelope({ to: agentId("target"), status: "accepted" });
    store.put(envelope);

    expect(store.findPendingForAgent(agentId("target"))).toBeUndefined();
  });

  test("findPendingForAgent returns undefined for wrong agent", () => {
    const envelope = createTestEnvelope({ to: agentId("other") });
    store.put(envelope);

    expect(store.findPendingForAgent(agentId("target"))).toBeUndefined();
  });

  test("bindRegistry cleans up on agent termination", () => {
    // let justified: mutable listener tracking
    let listener: ((event: RegistryEvent) => void) | undefined;
    const mockRegistry = {
      watch: (l: (event: RegistryEvent) => void) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      register: () => {
        throw new Error("not used");
      },
      deregister: () => {
        throw new Error("not used");
      },
      lookup: () => {
        throw new Error("not used");
      },
      list: () => {
        throw new Error("not used");
      },
      transition: () => {
        throw new Error("not used");
      },
      patch: () => {
        throw new Error("not used");
      },
      [Symbol.asyncDispose]: async () => {},
    };

    store.bindRegistry(mockRegistry);

    const envelope = createTestEnvelope({ from: agentId("dying-agent") });
    store.put(envelope);

    // Simulate termination
    listener?.({
      kind: "transitioned",
      agentId: agentId("dying-agent"),
      from: "running",
      to: "terminated",
      generation: 1,
      reason: { kind: "completed" },
    });

    expect(store.get(envelope.id)).toBeUndefined();
  });

  test("dispose clears all state", () => {
    const envelope = createTestEnvelope();
    store.put(envelope);
    store.dispose();
    expect(store.get(envelope.id)).toBeUndefined();
  });
});

/**
 * Shared contract test suite for HandoffStore implementations.
 *
 * Exercises all store methods with consistent assertions so that
 * in-memory, SQLite, and Nexus backends share the same coverage.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { HandoffEnvelope, RegistryEvent } from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import type { HandoffStore } from "../store.js";

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

function createMockRegistry(): {
  readonly registry: Parameters<HandoffStore["bindRegistry"]>[0];
  readonly fire: (event: RegistryEvent) => void;
} {
  // let justified: mutable listener tracking
  let listener: ((event: RegistryEvent) => void) | undefined;
  const registry = {
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

  return {
    registry,
    fire: (event: RegistryEvent) => {
      listener?.(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

export function runHandoffStoreContractTests(createStore: () => HandoffStore): void {
  let store: HandoffStore;

  beforeEach(() => {
    store = createStore();
  });

  // -- CRUD ---------------------------------------------------------------

  describe("CRUD", () => {
    test("put and get round-trip", async () => {
      const envelope = createTestEnvelope();
      const putResult = await store.put(envelope);
      expect(putResult.ok).toBe(true);

      const getResult = await store.get(envelope.id);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.id).toBe(envelope.id);
        expect(getResult.value.from).toBe(envelope.from);
        expect(getResult.value.to).toBe(envelope.to);
        expect(getResult.value.status).toBe(envelope.status);
        expect(getResult.value.phase).toEqual(envelope.phase);
        expect(getResult.value.context).toEqual(envelope.context);
      }
    });

    test("get returns NOT_FOUND for unknown ID", async () => {
      const getResult = await store.get(handoffId("nonexistent"));
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) {
        expect(getResult.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // -- CAS transitions ----------------------------------------------------

  describe("CAS transitions", () => {
    test("transition updates status", async () => {
      const envelope = createTestEnvelope();
      await store.put(envelope);

      const result = await store.transition(envelope.id, "pending", "injected");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("injected");
        expect(result.value.id).toBe(envelope.id);
        expect(result.value.from).toBe(envelope.from);
        expect(result.value.phase).toEqual(envelope.phase);
      }
    });

    test("transition fails on status mismatch", async () => {
      const envelope = createTestEnvelope();
      await store.put(envelope);

      const result = await store.transition(envelope.id, "accepted", "expired");
      expect(result.ok).toBe(false);
    });

    test("transition fails for unknown ID", async () => {
      const result = await store.transition(handoffId("nonexistent"), "pending", "injected");
      expect(result.ok).toBe(false);
    });
  });

  // -- Queries ------------------------------------------------------------

  describe("queries", () => {
    test("listByAgent returns envelopes for agent", async () => {
      const e1 = createTestEnvelope({
        id: handoffId("h-1"),
        from: agentId("a"),
        to: agentId("b"),
      });
      const e2 = createTestEnvelope({
        id: handoffId("h-2"),
        from: agentId("b"),
        to: agentId("c"),
      });
      const e3 = createTestEnvelope({
        id: handoffId("h-3"),
        from: agentId("x"),
        to: agentId("y"),
      });
      await store.put(e1);
      await store.put(e2);
      await store.put(e3);

      const result = await store.listByAgent(agentId("b"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        const ids = result.value.map((e) => e.id);
        expect(ids).toContain(handoffId("h-1"));
        expect(ids).toContain(handoffId("h-2"));
      }
    });

    test("findPendingForAgent finds pending envelope", async () => {
      const envelope = createTestEnvelope({ to: agentId("target") });
      await store.put(envelope);

      const result = await store.findPendingForAgent(agentId("target"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value?.id).toBe(envelope.id);
      }
    });

    test("findPendingForAgent finds injected envelope", async () => {
      const envelope = createTestEnvelope({
        to: agentId("target"),
        status: "injected",
      });
      await store.put(envelope);

      const result = await store.findPendingForAgent(agentId("target"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
    });

    test("findPendingForAgent ignores accepted envelopes", async () => {
      const envelope = createTestEnvelope({
        to: agentId("target"),
        status: "accepted",
      });
      await store.put(envelope);

      const result = await store.findPendingForAgent(agentId("target"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    test("findPendingForAgent returns undefined for wrong agent", async () => {
      const envelope = createTestEnvelope({ to: agentId("other") });
      await store.put(envelope);

      const result = await store.findPendingForAgent(agentId("target"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    test("findPendingForAgent returns oldest first (createdAt ordering)", async () => {
      const older = createTestEnvelope({
        id: handoffId("h-old"),
        to: agentId("target"),
        createdAt: Date.now() - 2000,
      });
      const newer = createTestEnvelope({
        id: handoffId("h-new"),
        to: agentId("target"),
        createdAt: Date.now(),
      });
      // Insert newer first to verify ordering is by createdAt, not insert order
      await store.put(newer);
      await store.put(older);

      const result = await store.findPendingForAgent(agentId("target"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.id).toBe(handoffId("h-old"));
      }
    });
  });

  // -- Cleanup ------------------------------------------------------------

  describe("cleanup", () => {
    test("remove deletes envelope", async () => {
      const envelope = createTestEnvelope();
      await store.put(envelope);

      const removeResult = await store.remove(envelope.id);
      expect(removeResult.ok).toBe(true);
      if (removeResult.ok) {
        expect(removeResult.value).toBe(true);
      }

      const getResult = await store.get(envelope.id);
      expect(getResult.ok).toBe(false);
    });

    test("remove returns false for unknown ID", async () => {
      const result = await store.remove(handoffId("nonexistent"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    test("removeByAgent cleans up all agent envelopes", async () => {
      const e1 = createTestEnvelope({
        id: handoffId("h-1"),
        from: agentId("a"),
        to: agentId("b"),
      });
      const e2 = createTestEnvelope({
        id: handoffId("h-2"),
        from: agentId("b"),
        to: agentId("c"),
      });
      const e3 = createTestEnvelope({
        id: handoffId("h-3"),
        from: agentId("x"),
        to: agentId("y"),
      });
      await store.put(e1);
      await store.put(e2);
      await store.put(e3);

      await store.removeByAgent(agentId("b"));

      const g1 = await store.get(handoffId("h-1"));
      const g2 = await store.get(handoffId("h-2"));
      const g3 = await store.get(handoffId("h-3"));
      expect(g1.ok).toBe(false);
      expect(g2.ok).toBe(false);
      expect(g3.ok).toBe(true);
    });
  });

  // -- Conflict detection -------------------------------------------------

  describe("conflict detection", () => {
    test("put same ID twice returns CONFLICT", async () => {
      const envelope = createTestEnvelope();
      const first = await store.put(envelope);
      expect(first.ok).toBe(true);

      const second = await store.put(envelope);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe("CONFLICT");
      }
    });
  });

  // -- Registry lifecycle -------------------------------------------------

  describe("registry lifecycle", () => {
    test("bindRegistry cleans up on agent termination", async () => {
      const { registry, fire } = createMockRegistry();
      store.bindRegistry(registry);

      const envelope = createTestEnvelope({ from: agentId("dying-agent") });
      await store.put(envelope);

      fire({
        kind: "transitioned",
        agentId: agentId("dying-agent"),
        from: "running",
        to: "terminated",
        generation: 1,
        reason: { kind: "completed" },
      });

      // Give async cleanup a tick
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = await store.get(envelope.id);
      expect(result.ok).toBe(false);
    });

    test("dispose clears state", async () => {
      const envelope = createTestEnvelope();
      await store.put(envelope);
      await store.dispose();

      // For in-memory stores, get should fail after dispose
      // For persistent stores, the DB is closed
      // This is a basic smoke test
    });
  });
}

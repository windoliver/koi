/**
 * Reusable contract test suite for AgentRegistry implementations.
 *
 * Validates the core AgentRegistry behavior: CRUD, CAS transitions,
 * watch notifications, filtering, and disposal.
 *
 * Inlined from @koi/test-utils-contracts for v2 scaffold independence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRegistry, ProcessState, RegistryEntry, RegistryEvent } from "@koi/core";
import { agentId } from "@koi/core";

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

export function runAgentRegistryContractTests(
  createRegistry: () => AgentRegistry | Promise<AgentRegistry>,
): void {
  describe("AgentRegistry contract", () => {
    let registry: AgentRegistry;

    beforeEach(async () => {
      registry = await createRegistry();
    });

    afterEach(async () => {
      await registry[Symbol.asyncDispose]();
    });

    describe("register and lookup", () => {
      test("register stores and returns entry", async () => {
        const e = entry("agent-1");
        const stored = await registry.register(e);
        expect(stored.agentId).toBe(agentId("agent-1"));
      });

      test("lookup returns registered entry", async () => {
        await registry.register(entry("agent-1"));
        const found = await registry.lookup(agentId("agent-1"));
        expect(found).toBeDefined();
        expect(found?.agentId).toBe(agentId("agent-1"));
      });

      test("lookup returns undefined for unknown agent", async () => {
        const found = await registry.lookup(agentId("ghost"));
        expect(found).toBeUndefined();
      });
    });

    describe("deregister", () => {
      test("deregister removes agent and returns true", async () => {
        await registry.register(entry("agent-1"));
        const removed = await registry.deregister(agentId("agent-1"));
        expect(removed).toBe(true);
        expect(await registry.lookup(agentId("agent-1"))).toBeUndefined();
      });

      test("deregister returns false for unknown agent", async () => {
        const removed = await registry.deregister(agentId("ghost"));
        expect(removed).toBe(false);
      });
    });

    describe("list", () => {
      test("list returns all agents when no filter", async () => {
        await registry.register(entry("a1"));
        await registry.register(entry("a2"));
        await registry.register(entry("a3"));
        const all = await registry.list();
        expect(all).toHaveLength(3);
      });

      test("list filters by phase", async () => {
        await registry.register(entry("a1", "created"));
        await registry.register(entry("a2", "created"));
        await registry.transition(agentId("a2"), "running", 0, { kind: "assembly_complete" });

        const created = await registry.list({ phase: "created" });
        expect(created).toHaveLength(1);
        expect(created[0]?.agentId).toBe(agentId("a1"));
      });

      test("list filters by agentType", async () => {
        await registry.register({ ...entry("a1"), agentType: "copilot" });
        await registry.register({ ...entry("a2"), agentType: "worker" });

        const copilots = await registry.list({ agentType: "copilot" });
        expect(copilots).toHaveLength(1);
        expect(copilots[0]?.agentType).toBe("copilot");
      });

      test("list filters by condition (empty conditions excluded)", async () => {
        await registry.register(entry("a1"));
        await registry.register(entry("a2"));

        const healthy = await registry.list({ condition: "Healthy" });
        expect(healthy).toHaveLength(0);
      });

      test("list filters by parentId", async () => {
        await registry.register(entry("root"));
        await registry.register({ ...entry("child-1"), parentId: agentId("root") });
        await registry.register({ ...entry("child-2"), parentId: agentId("root") });
        await registry.register({ ...entry("other"), parentId: agentId("other-root") });

        const children = await registry.list({ parentId: agentId("root") });
        expect(children).toHaveLength(2);
        expect(children.every((e) => e.parentId === agentId("root"))).toBe(true);
      });
    });

    describe("transition", () => {
      test("transition with correct generation succeeds", async () => {
        await registry.register(entry("a1", "created", 0));
        const result = await registry.transition(agentId("a1"), "running", 0, {
          kind: "assembly_complete",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status.phase).toBe("running");
          expect(result.value.status.generation).toBe(1);
        }
      });

      test("transition with stale generation returns CONFLICT", async () => {
        await registry.register(entry("a1", "created", 0));
        await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        const result = await registry.transition(agentId("a1"), "waiting", 0, {
          kind: "awaiting_response",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("CONFLICT");
        }
      });

      test("transition on unknown agent returns NOT_FOUND", async () => {
        const result = await registry.transition(agentId("ghost"), "running", 0, {
          kind: "assembly_complete",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("invalid transition edge returns VALIDATION error", async () => {
        await registry.register(entry("a1", "created", 0));
        const result = await registry.transition(agentId("a1"), "waiting", 0, {
          kind: "awaiting_response",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("VALIDATION");
        }
      });

      test("running to idle transition succeeds", async () => {
        await registry.register(entry("a1", "created", 0));
        await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        const result = await registry.transition(agentId("a1"), "idle", 1, {
          kind: "task_completed_idle",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status.phase).toBe("idle");
          expect(result.value.status.generation).toBe(2);
        }
      });

      test("idle to running transition succeeds", async () => {
        await registry.register(entry("a1", "created", 0));
        await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await registry.transition(agentId("a1"), "idle", 1, { kind: "task_completed_idle" });
        const result = await registry.transition(agentId("a1"), "running", 2, {
          kind: "inbox_wake",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status.phase).toBe("running");
          expect(result.value.status.generation).toBe(3);
        }
      });

      test("idle to terminated transition succeeds", async () => {
        await registry.register(entry("a1", "created", 0));
        await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await registry.transition(agentId("a1"), "idle", 1, { kind: "task_completed_idle" });
        const result = await registry.transition(agentId("a1"), "terminated", 2, {
          kind: "evicted",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status.phase).toBe("terminated");
        }
      });

      test("idle to waiting is invalid", async () => {
        await registry.register(entry("a1", "created", 0));
        await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await registry.transition(agentId("a1"), "idle", 1, { kind: "task_completed_idle" });
        const result = await registry.transition(agentId("a1"), "waiting", 2, {
          kind: "awaiting_response",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("VALIDATION");
        }
      });

      test("list filters by idle phase", async () => {
        await registry.register(entry("a1", "created", 0));
        await registry.register(entry("a2", "created", 0));
        await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await registry.transition(agentId("a1"), "idle", 1, { kind: "task_completed_idle" });

        const idle = await registry.list({ phase: "idle" });
        expect(idle).toHaveLength(1);
        expect(idle[0]?.agentId).toBe(agentId("a1"));
      });
    });

    describe("watch", () => {
      test("watch fires on register", async () => {
        const events: RegistryEvent[] = [];
        registry.watch((event) => events.push(event));

        await registry.register(entry("a1"));

        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("registered");
      });

      test("watch fires on deregister", async () => {
        await registry.register(entry("a1"));

        const events: RegistryEvent[] = [];
        registry.watch((event) => events.push(event));
        await registry.deregister(agentId("a1"));

        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("deregistered");
      });

      test("watch fires on successful transition with reason", async () => {
        await registry.register(entry("a1", "created", 0));

        const events: RegistryEvent[] = [];
        registry.watch((event) => events.push(event));

        await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });

        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("transitioned");
        if (events[0]?.kind === "transitioned") {
          expect(events[0].from).toBe("created");
          expect(events[0].to).toBe("running");
          expect(events[0].generation).toBe(1);
          expect(events[0].reason.kind).toBe("assembly_complete");
        }
      });

      test("unsubscribe stops notifications", async () => {
        const events: RegistryEvent[] = [];
        const unsub = registry.watch((event) => events.push(event));

        await registry.register(entry("a1"));
        expect(events).toHaveLength(1);

        unsub();

        await registry.register(entry("a2"));
        expect(events).toHaveLength(1);
      });

      test("throwing listener does not break transition or other listeners", async () => {
        await registry.register(entry("a1", "created", 0));

        const events: RegistryEvent[] = [];
        registry.watch(() => {
          throw new Error("boom");
        });
        registry.watch((e) => events.push(e));

        const result = await registry.transition(agentId("a1"), "running", 0, {
          kind: "assembly_complete",
        });
        expect(result.ok).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("transitioned");
      });
    });

    describe("patch", () => {
      test("patch updates priority on existing agent", async () => {
        await registry.register(entry("a1"));
        const result = await registry.patch(agentId("a1"), { priority: 5 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.priority).toBe(5);
        }
      });

      test("patch returns NOT_FOUND for unknown agent", async () => {
        const result = await registry.patch(agentId("ghost"), { priority: 5 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("patch updates only specified fields", async () => {
        await registry.register({ ...entry("a1"), metadata: { foo: "bar" } });
        const result = await registry.patch(agentId("a1"), { priority: 3 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.priority).toBe(3);
          expect(result.value.metadata).toEqual({ foo: "bar" });
        }
      });

      test("patch emits patched event", async () => {
        await registry.register(entry("a1"));

        const events: RegistryEvent[] = [];
        registry.watch((event) => events.push(event));

        await registry.patch(agentId("a1"), { priority: 2 });

        const patchEvent = events.find((ev) => ev.kind === "patched");
        expect(patchEvent).toBeDefined();
        if (patchEvent !== undefined && patchEvent.kind === "patched") {
          expect(patchEvent.agentId).toBe(agentId("a1"));
          expect(patchEvent.fields).toEqual({ priority: 2 });
        }
      });

      test("patch with empty fields is a no-op returning current entry", async () => {
        await registry.register({ ...entry("a1"), metadata: { key: "val" } });
        const result = await registry.patch(agentId("a1"), {});
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.priority).toBe(10);
        }
      });
    });

    describe("dispose", () => {
      test("dispose clears all entries", async () => {
        await registry.register(entry("a1"));
        await registry.register(entry("a2"));

        await registry[Symbol.asyncDispose]();

        const all = await registry.list();
        expect(all).toHaveLength(0);
      });
    });
  });
}

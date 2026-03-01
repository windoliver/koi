/**
 * Tests for AgentRegistry.patch() — in-memory implementation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { RegistryEntry, RegistryEvent } from "@koi/core";
import { agentId, zoneId } from "@koi/core";
import type { InMemoryRegistry } from "./registry.js";
import { createInMemoryRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(id: string, overrides?: Partial<RegistryEntry>): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registry.patch()", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  test("updates priority on existing agent", () => {
    const e = entry("agent-1");
    registry.register(e);

    const result = registry.patch(agentId("agent-1"), { priority: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(5);
    }
  });

  test("returns NOT_FOUND for missing agent", () => {
    const result = registry.patch(agentId("nonexistent"), { priority: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("updates only specified fields (priority without touching metadata)", () => {
    const e = entry("agent-1", { metadata: { foo: "bar" } });
    registry.register(e);

    const result = registry.patch(agentId("agent-1"), { priority: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(3);
      expect(result.value.metadata).toEqual({ foo: "bar" });
    }
  });

  test("updates metadata without touching priority", () => {
    const e = entry("agent-1", { priority: 5 });
    registry.register(e);

    const result = registry.patch(agentId("agent-1"), { metadata: { key: "value" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(5);
      expect(result.value.metadata).toEqual({ key: "value" });
    }
  });

  test("updates zoneId", () => {
    const e = entry("agent-1");
    registry.register(e);

    const zone = zoneId("us-east-1");
    const result = registry.patch(agentId("agent-1"), { zoneId: zone });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.zoneId).toBe(zone);
    }
  });

  test("all-undefined fields is a no-op, returns current entry", () => {
    const e = entry("agent-1", { priority: 7 });
    registry.register(e);

    const result = registry.patch(agentId("agent-1"), {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(7);
    }
  });

  test("emits patched RegistryEvent", () => {
    const e = entry("agent-1");
    registry.register(e);

    const events: RegistryEvent[] = []; // let justified: collecting events
    registry.watch((event) => {
      events.push(event);
    });

    registry.patch(agentId("agent-1"), { priority: 2 });

    const patchEvent = events.find((ev) => ev.kind === "patched");
    expect(patchEvent).toBeDefined();
    if (patchEvent !== undefined && patchEvent.kind === "patched") {
      expect(patchEvent.agentId).toBe(agentId("agent-1"));
      expect(patchEvent.fields).toEqual({ priority: 2 });
      expect(patchEvent.entry.priority).toBe(2);
    }
  });

  test("patch + transition concurrent via Promise.all — both succeed", async () => {
    const e = entry("agent-1", {
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      priority: 10,
    });
    registry.register(e);

    const [patchResult, transitionResult] = await Promise.all([
      registry.patch(agentId("agent-1"), { priority: 1 }),
      registry.transition(agentId("agent-1"), "running", 0, { kind: "assembly_complete" }),
    ]);

    expect(patchResult.ok).toBe(true);
    expect(transitionResult.ok).toBe(true);
  });

  test("two patches racing — last writer wins", () => {
    const e = entry("agent-1");
    registry.register(e);

    registry.patch(agentId("agent-1"), { priority: 3 });
    registry.patch(agentId("agent-1"), { priority: 7 });

    const lookup = registry.lookup(agentId("agent-1"));
    expect(lookup?.priority).toBe(7);
  });

  test("patch persists in lookup", () => {
    const e = entry("agent-1");
    registry.register(e);

    registry.patch(agentId("agent-1"), { priority: 0, metadata: { updated: true } });

    const lookup = registry.lookup(agentId("agent-1"));
    expect(lookup?.priority).toBe(0);
    expect(lookup?.metadata).toEqual({ updated: true });
  });
});

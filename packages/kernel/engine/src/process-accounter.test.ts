import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProcessState, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import type { SharedProcessAccounter } from "./process-accounter.js";
import { createProcessAccounter } from "./process-accounter.js";
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
    priority: 10,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SharedProcessAccounter", () => {
  let registry: InMemoryRegistry;
  let accounter: SharedProcessAccounter;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    accounter = createProcessAccounter(registry);
  });

  afterEach(async () => {
    await accounter[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  test("increments on register", () => {
    expect(accounter.activeCount()).toBe(0);
    registry.register(entry("a1"));
    expect(accounter.activeCount()).toBe(1);
    registry.register(entry("a2"));
    expect(accounter.activeCount()).toBe(2);
  });

  test("decrements on deregister", () => {
    registry.register(entry("a1"));
    registry.register(entry("a2"));
    expect(accounter.activeCount()).toBe(2);

    registry.deregister(agentId("a1"));
    expect(accounter.activeCount()).toBe(1);
  });

  test("decrements on transition to terminated", () => {
    registry.register(entry("a1", "running", 0));
    expect(accounter.activeCount()).toBe(1);

    registry.transition(agentId("a1"), "terminated", 0, { kind: "completed" });
    expect(accounter.activeCount()).toBe(0);
  });

  test("manual increment and decrement", () => {
    expect(accounter.activeCount()).toBe(0);
    accounter.increment();
    accounter.increment();
    expect(accounter.activeCount()).toBe(2);
    accounter.decrement();
    expect(accounter.activeCount()).toBe(1);
  });

  test("never goes below zero", () => {
    expect(accounter.activeCount()).toBe(0);
    accounter.decrement();
    expect(accounter.activeCount()).toBe(0);
    accounter.decrement();
    expect(accounter.activeCount()).toBe(0);
  });

  test("no double-decrement on terminate then deregister", () => {
    registry.register(entry("a1", "running", 0));
    registry.register(entry("a2", "running", 0));
    expect(accounter.activeCount()).toBe(2);

    // Terminate a1 — count should go to 1
    registry.transition(agentId("a1"), "terminated", 0, { kind: "completed" });
    expect(accounter.activeCount()).toBe(1);

    // Deregister a1 — should NOT decrement again
    registry.deregister(agentId("a1"));
    expect(accounter.activeCount()).toBe(1);

    // a2 is still active
    registry.transition(agentId("a2"), "terminated", 0, { kind: "completed" });
    expect(accounter.activeCount()).toBe(0);
  });

  test("dispose resets count", async () => {
    registry.register(entry("a1"));
    registry.register(entry("a2"));
    expect(accounter.activeCount()).toBe(2);

    await accounter[Symbol.asyncDispose]();
    expect(accounter.activeCount()).toBe(0);
  });
});

/**
 * Unit tests for lifecycle.ts pure functions.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "./ecs.js";
import type { RegistryEntry, RegistryFilter } from "./lifecycle.js";
import { matchesFilter } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(overrides?: Partial<RegistryEntry>): RegistryEntry {
  return {
    agentId: agentId("test-agent"),
    status: {
      phase: "running",
      generation: 1,
      conditions: ["Ready", "Healthy"],
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

describe("matchesFilter", () => {
  test("returns true when filter is empty", () => {
    const e = entry();
    const filter: RegistryFilter = {};
    expect(matchesFilter(e, filter)).toBe(true);
  });

  test("matches by phase", () => {
    const e = entry();
    expect(matchesFilter(e, { phase: "running" })).toBe(true);
    expect(matchesFilter(e, { phase: "created" })).toBe(false);
  });

  test("matches by agentType", () => {
    const e = entry();
    expect(matchesFilter(e, { agentType: "worker" })).toBe(true);
    expect(matchesFilter(e, { agentType: "copilot" })).toBe(false);
  });

  test("matches by condition", () => {
    const e = entry();
    expect(matchesFilter(e, { condition: "Ready" })).toBe(true);
    expect(matchesFilter(e, { condition: "Healthy" })).toBe(true);
    expect(matchesFilter(e, { condition: "Draining" })).toBe(false);
  });

  test("matches by parentId", () => {
    const parent = agentId("parent-1");
    const e = entry({ parentId: parent });
    expect(matchesFilter(e, { parentId: parent })).toBe(true);
    expect(matchesFilter(e, { parentId: agentId("other") })).toBe(false);
  });

  test("rejects when parentId filter set but entry has no parentId", () => {
    const e = entry(); // no parentId
    expect(matchesFilter(e, { parentId: agentId("parent-1") })).toBe(false);
  });

  test("matches with multiple filter criteria (AND semantics)", () => {
    const e = entry({ agentType: "copilot" });
    expect(matchesFilter(e, { phase: "running", agentType: "copilot" })).toBe(true);
    expect(matchesFilter(e, { phase: "running", agentType: "worker" })).toBe(false);
    expect(matchesFilter(e, { phase: "created", agentType: "copilot" })).toBe(false);
  });

  test("matches entry with empty conditions against no condition filter", () => {
    const e = entry({
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
    });
    expect(matchesFilter(e, { phase: "created" })).toBe(true);
  });

  test("rejects entry with empty conditions when condition filter is set", () => {
    const e = entry({
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
    });
    expect(matchesFilter(e, { condition: "Ready" })).toBe(false);
  });
});

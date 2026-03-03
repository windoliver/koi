/**
 * Tests for skill-based agent discovery.
 */

import { describe, expect, test } from "bun:test";
import type { AgentRegistry, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import { discoverBySkill } from "./discovery.js";

// ---------------------------------------------------------------------------
// Minimal in-memory registry stub for testing discovery
// ---------------------------------------------------------------------------

function createStubRegistry(entries: readonly RegistryEntry[]): AgentRegistry {
  const store = new Map(entries.map((e) => [e.agentId, e]));

  return {
    register: (entry) => entry,
    deregister: () => false,
    lookup: (id) => store.get(id),
    list: () => [...store.values()],
    transition: () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "stub", retryable: false },
    }),
    patch: () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "stub", retryable: false },
    }),
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

function entry(id: string, skills?: readonly string[]): RegistryEntry {
  return {
    agentId: agentId(id),
    status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
    agentType: "worker",
    metadata: skills !== undefined ? { skills: [...skills] } : {},
    registeredAt: Date.now(),
    priority: 10,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverBySkill", () => {
  test("finds agents with matching skill", async () => {
    const registry = createStubRegistry([
      entry("a1", ["code-review", "testing"]),
      entry("a2", ["code-review"]),
      entry("a3", ["deployment"]),
    ]);

    const results = await discoverBySkill(registry, "code-review");
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.agentId)).toEqual([agentId("a1"), agentId("a2")]);
  });

  test("returns empty when no agents have the skill", async () => {
    const registry = createStubRegistry([entry("a1", ["code-review"]), entry("a2", ["testing"])]);

    const results = await discoverBySkill(registry, "deployment");
    expect(results).toHaveLength(0);
  });

  test("returns empty when agents have no skills metadata", async () => {
    const registry = createStubRegistry([entry("a1"), entry("a2")]);

    const results = await discoverBySkill(registry, "any-skill");
    expect(results).toHaveLength(0);
  });

  test("returns empty for empty registry", async () => {
    const registry = createStubRegistry([]);
    const results = await discoverBySkill(registry, "skill");
    expect(results).toHaveLength(0);
  });

  test("handles non-array skills metadata gracefully", async () => {
    const registry = createStubRegistry([
      {
        ...entry("a1"),
        metadata: { skills: "not-an-array" },
      },
    ]);

    const results = await discoverBySkill(registry, "not-an-array");
    expect(results).toHaveLength(0);
  });
});

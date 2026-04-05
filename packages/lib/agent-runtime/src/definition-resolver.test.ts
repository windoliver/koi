/**
 * Tests for createDefinitionResolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "@koi/core";

import { createAgentDefinitionRegistry } from "./agent-definition-registry.js";
import { getBuiltInAgents } from "./built-in/index.js";
import { createDefinitionResolver } from "./definition-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal AgentDefinition for tests.
 * manifest.name is deliberately set to a display label different from agentType
 * so that tests can confirm the resolver uses agentType (the lookup key) and not
 * manifest.name (the display label) when populating TaskableAgentSummary.name.
 */
function makeMinimalDef(agentType: string): AgentDefinition {
  return {
    agentType,
    name: agentType,
    description: `A ${agentType} agent`,
    whenToUse: `Use ${agentType} when you need specialised ${agentType}-related handling`,
    source: "built-in",
    manifest: {
      name: `Display Name For ${agentType}`, // deliberately DIFFERENT from agentType
      version: "0.1.0",
      model: { name: "sonnet" },
    },
  };
}

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

describe("createDefinitionResolver — resolve()", () => {
  test("returns ok: true with the definition for a known agentType", async () => {
    const registry = createAgentDefinitionRegistry([makeMinimalDef("researcher")], []);
    const resolver = createDefinitionResolver(registry);

    const result = await resolver.resolve("researcher");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // name is on TaskableAgent (the resolver contract type); agentType === name in our impl
      expect(result.value.name).toBe("researcher");
    }
  });

  test("returns NOT_FOUND for an unknown agentType", async () => {
    const registry = createAgentDefinitionRegistry([makeMinimalDef("researcher")], []);
    const resolver = createDefinitionResolver(registry);

    const result = await resolver.resolve("nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("NOT_FOUND error includes available agent names so the LLM can self-correct", async () => {
    const registry = createAgentDefinitionRegistry(
      [makeMinimalDef("researcher"), makeMinimalDef("coder")],
      [],
    );
    const resolver = createDefinitionResolver(registry);

    // Simulate an LLM typo
    const result = await resolver.resolve("researher");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("researcher");
      expect(result.error.message).toContain("coder");
    }
  });

  test("NOT_FOUND on an empty registry mentions 'no agents loaded'", async () => {
    const registry = createAgentDefinitionRegistry([], []);
    const resolver = createDefinitionResolver(registry);

    const result = await resolver.resolve("anything");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no agents loaded");
    }
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("createDefinitionResolver — list()", () => {
  test("uses agentType as name — not manifest.name — so the LLM passes the correct value to agent_spawn", async () => {
    // manifest.name is "Display Name For researcher"; agentType is "researcher"
    // Before the fix, list() returned manifest.name, causing LLM routing failures.
    const registry = createAgentDefinitionRegistry([makeMinimalDef("researcher")], []);
    const resolver = createDefinitionResolver(registry);

    const summaries = await resolver.list();

    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary?.key).toBe("researcher");
    expect(summary?.name).toBe("researcher"); // NOT "Display Name For researcher"
  });

  test("uses whenToUse as description", async () => {
    const registry = createAgentDefinitionRegistry([makeMinimalDef("coder")], []);
    const resolver = createDefinitionResolver(registry);

    const summaries = await resolver.list();
    const [summary] = summaries;

    expect(summary?.description).toContain("coder");
  });

  test("key and name are always equal (both are agentType)", async () => {
    const registry = createAgentDefinitionRegistry(
      [makeMinimalDef("researcher"), makeMinimalDef("coder"), makeMinimalDef("reviewer")],
      [],
    );
    const resolver = createDefinitionResolver(registry);

    for (const summary of await resolver.list()) {
      expect(summary.name).toBe(summary.key);
    }
  });

  test("real built-in agents: list() returns agentType as name for all", async () => {
    const registry = createAgentDefinitionRegistry(getBuiltInAgents(), []);
    const resolver = createDefinitionResolver(registry);

    for (const summary of await resolver.list()) {
      expect(summary.name).toBe(summary.key);
    }
  });
});

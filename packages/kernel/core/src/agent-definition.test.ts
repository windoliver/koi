/**
 * Unit tests for L0 agent definition types.
 */

import { describe, expect, test } from "bun:test";
import type { AgentDefinition, AgentDefinitionSource } from "./agent-definition.js";
import { AGENT_DEFINITION_PRIORITY } from "./agent-definition.js";

describe("AgentDefinition", () => {
  test("is constructible with all required fields", () => {
    const def: AgentDefinition = {
      agentType: "researcher",
      whenToUse: "Deep research on complex topics",
      source: "built-in",
      manifest: { name: "researcher", version: "1.0.0", model: { name: "sonnet" } },
      systemPrompt: "You are a research specialist.",
      name: "researcher",
      description: "Deep research on complex topics",
    };
    expect(def.agentType).toBe("researcher");
    expect(def.whenToUse).toBe("Deep research on complex topics");
    expect(def.source).toBe("built-in");
    expect(def.manifest.name).toBe("researcher");
    expect(def.systemPrompt).toBe("You are a research specialist.");
    expect(def.brickId).toBeUndefined();
  });

  test("backward-compat: name and description mirror agentType and whenToUse", () => {
    const def: AgentDefinition = {
      agentType: "coder",
      whenToUse: "Code implementation",
      source: "project",
      manifest: { name: "coder", version: "1.0.0", model: { name: "sonnet" } },
      name: "coder",
      description: "Code implementation",
    };
    // Old TaskableAgent consumers read .name and .description
    expect(def.name).toBe("coder");
    expect(def.description).toBe("Code implementation");
  });
});

describe("AGENT_DEFINITION_PRIORITY", () => {
  test("has correct ordering: built-in < user < project", () => {
    expect(AGENT_DEFINITION_PRIORITY["built-in"]).toBeLessThan(AGENT_DEFINITION_PRIORITY.user);
    expect(AGENT_DEFINITION_PRIORITY.user).toBeLessThan(AGENT_DEFINITION_PRIORITY.project);
  });
});

describe("AgentDefinitionSource", () => {
  test("union covers all 3 values", () => {
    const sources: readonly AgentDefinitionSource[] = ["built-in", "user", "project"];
    expect(sources).toHaveLength(3);
    // Verify each is a valid key in the priority map
    for (const s of sources) {
      expect(AGENT_DEFINITION_PRIORITY[s]).toBeDefined();
    }
  });
});

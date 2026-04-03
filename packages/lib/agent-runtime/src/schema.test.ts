/**
 * Unit tests for the agent definition Zod schema and validation.
 */

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "@koi/core";
import { mapFrontmatterToDefinition, validateAgentFrontmatter } from "./schema.js";
import { validateAgentType } from "./validate-agent-type.js";

describe("validateAgentFrontmatter", () => {
  test("accepts valid frontmatter with all supported fields", () => {
    const result = validateAgentFrontmatter({
      name: "researcher",
      description: "Deep research agent for complex topics",
      model: "opus",
    });
    expect(result.success).toBe(true);
  });

  test("accepts minimal frontmatter (name + description only)", () => {
    const result = validateAgentFrontmatter({
      name: "minimal",
      description: "A minimal agent",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing name", () => {
    const result = validateAgentFrontmatter({
      description: "No name provided",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing description", () => {
    const result = validateAgentFrontmatter({
      name: "no-desc",
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown frontmatter keys (strict schema)", () => {
    const result = validateAgentFrontmatter({
      name: "test-agent",
      description: "A test agent",
      maxTurns: 20,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.toLowerCase().includes("unrecognized"))).toBe(true);
    }
  });
});

describe("validateAgentType", () => {
  test("accepts valid agent types", () => {
    expect(validateAgentType("researcher").ok).toBe(true);
    expect(validateAgentType("code-reviewer").ok).toBe(true);
    expect(validateAgentType("abc").ok).toBe(true);
  });

  test("rejects path traversal attempts", () => {
    const result = validateAgentType("../../etc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("invalid");
    }
  });

  test("rejects names shorter than 3 characters", () => {
    const result = validateAgentType("ab");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("too short");
    }
  });

  test("rejects names longer than 50 characters", () => {
    const result = validateAgentType("a".repeat(51));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("too long");
    }
  });

  test("rejects names with spaces", () => {
    const result = validateAgentType("my agent");
    expect(result.ok).toBe(false);
  });

  test("rejects leading/trailing hyphens", () => {
    expect(validateAgentType("-bad").ok).toBe(false);
    expect(validateAgentType("bad-").ok).toBe(false);
  });
});

describe("mapFrontmatterToDefinition", () => {
  test("transforms frontmatter + body into AgentDefinition", () => {
    const def: AgentDefinition = mapFrontmatterToDefinition(
      { name: "researcher", description: "Research agent", model: "opus" },
      "You are a research specialist.",
      "built-in",
    );

    expect(def.agentType).toBe("researcher");
    expect(def.whenToUse).toBe("Research agent");
    expect(def.source).toBe("built-in");
    expect(def.manifest.name).toBe("researcher");
    expect(def.manifest.model.name).toBe("opus");
  });

  test("systemPrompt carries the Markdown body, not manifest.description", () => {
    const def = mapFrontmatterToDefinition(
      { name: "test", description: "A test agent" },
      "You are a test agent. Follow these instructions.",
      "built-in",
    );
    // systemPrompt is the Markdown body — what gets injected into SpawnRequest
    expect(def.systemPrompt).toBe("You are a test agent. Follow these instructions.");
    // manifest.description is the short description from frontmatter
    expect(def.manifest.description).toBe("A test agent");
  });

  test("backward-compat: name and description fields are populated", () => {
    const def = mapFrontmatterToDefinition(
      { name: "researcher", description: "Research agent" },
      "prompt",
      "project",
    );
    expect(def.name).toBe("researcher");
    expect(def.description).toBe("Research agent");
  });

  test("uses default model when not specified", () => {
    const def = mapFrontmatterToDefinition({ name: "test", description: "test" }, "", "project");
    expect(def.manifest.model.name).toBe("sonnet");
  });

  test("empty systemPrompt is omitted from the definition", () => {
    const def = mapFrontmatterToDefinition({ name: "test", description: "test" }, "", "built-in");
    expect(def.systemPrompt).toBeUndefined();
  });
});

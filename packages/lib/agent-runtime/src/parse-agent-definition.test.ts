/**
 * Pipeline unit tests for parseAgentDefinition — verifies each stage independently.
 */

import { describe, expect, test } from "bun:test";
import { parseAgentDefinition } from "./parse-agent-definition.js";

describe("parseAgentDefinition", () => {
  test("full success: valid input produces correct AgentDefinition", () => {
    const content =
      "---\nname: researcher\ndescription: Deep research agent\nmodel: opus\n---\n\nYou are a research specialist.";
    const result = parseAgentDefinition(content, "built-in");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentType).toBe("researcher");
      expect(result.value.whenToUse).toBe("Deep research agent");
      expect(result.value.source).toBe("built-in");
      expect(result.value.manifest.model.name).toBe("opus");
      expect(result.value.systemPrompt).toBe("You are a research specialist.");
    }
  });

  test("empty body produces undefined systemPrompt", () => {
    const content = "---\nname: minimal\ndescription: A minimal agent\n---";
    const result = parseAgentDefinition(content, "project");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.systemPrompt).toBeUndefined();
    }
  });

  test("stage 1 failure: malformed YAML returns VALIDATION error", () => {
    const content = '---\nname: "unclosed\n---\n\nBody.';
    const result = parseAgentDefinition(content, "user");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Malformed YAML");
    }
  });

  test("stage 2 failure: missing required field mentions field name", () => {
    const content = "---\ndescription: Missing name\n---\n\nBody.";
    const result = parseAgentDefinition(content, "project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Invalid agent definition");
    }
  });

  test("stage 2 failure: unknown key in strict schema mentions unrecognized", () => {
    const content = "---\nname: test-agent\ndescription: A test\nmaxTurns: 20\n---\n\nBody.";
    const result = parseAgentDefinition(content, "project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message.toLowerCase()).toContain("unrecognized");
    }
  });

  test("stage 3 failure: invalid agent type name", () => {
    const content = "---\nname: ab\ndescription: Too short\n---\n\nBody.";
    const result = parseAgentDefinition(content, "user");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("too short");
    }
  });

  test("source is correctly passed through to definition", () => {
    const content = "---\nname: test-agent\ndescription: Test\n---\n\nPrompt.";
    const userResult = parseAgentDefinition(content, "user");
    const projectResult = parseAgentDefinition(content, "project");
    const builtInResult = parseAgentDefinition(content, "built-in");

    expect(userResult.ok && userResult.value.source).toBe("user");
    expect(projectResult.ok && projectResult.value.source).toBe("project");
    expect(builtInResult.ok && builtInResult.value.source).toBe("built-in");
  });

  test("default model is sonnet when not specified", () => {
    const content = "---\nname: test-agent\ndescription: Test\n---\n\nPrompt.";
    const result = parseAgentDefinition(content, "built-in");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.model.name).toBe("sonnet");
    }
  });
});

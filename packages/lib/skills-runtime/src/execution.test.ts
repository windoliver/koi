/**
 * Tests for skill execution mode behavior.
 *
 * Covers:
 * - mapSkillToSpawnRequest() creates correct SpawnRequest from fork-mode skill
 * - systemPrompt comes from skill body
 * - toolAllowlist comes from skill allowedTools
 * - description comes from skill name
 * - Inline mode: no spawn request (undefined)
 * - Default (no executionMode) treated as inline
 * - Caller override: force fork on an inline skill
 */
import { describe, expect, test } from "bun:test";
import { mapSkillToSpawnRequest } from "./execution.js";
import type { SkillDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "A test skill.",
    body: "# Instructions\n\nDo the thing.",
    source: "user",
    dirPath: "/tmp/skills/test-skill",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapSkillToSpawnRequest", () => {
  test("fork-mode skill produces a SpawnRequest", () => {
    const skill = makeSkill({ executionMode: "fork" });
    const result = mapSkillToSpawnRequest(skill);
    expect(result).toBeDefined();
  });

  test("SpawnRequest.description is the skill name", () => {
    const skill = makeSkill({ executionMode: "fork", name: "deep-analysis" });
    const result = mapSkillToSpawnRequest(skill);
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.description).toBe("deep-analysis");
  });

  test("SpawnRequest.systemPrompt is the skill body", () => {
    const skill = makeSkill({
      executionMode: "fork",
      body: "# Review\n\nCheck for bugs.",
    });
    const result = mapSkillToSpawnRequest(skill);
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.systemPrompt).toBe("# Review\n\nCheck for bugs.");
  });

  test("SpawnRequest.toolAllowlist comes from skill allowedTools", () => {
    const skill = makeSkill({
      executionMode: "fork",
      allowedTools: ["read_file", "grep"],
    });
    const result = mapSkillToSpawnRequest(skill);
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.toolAllowlist).toEqual(["read_file", "grep"]);
  });

  test("SpawnRequest.toolAllowlist is undefined when skill has no allowedTools", () => {
    const skill = makeSkill({ executionMode: "fork" });
    const result = mapSkillToSpawnRequest(skill);
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.toolAllowlist).toBeUndefined();
  });

  test("inline-mode skill returns undefined (no spawn)", () => {
    const skill = makeSkill({ executionMode: "inline" });
    const result = mapSkillToSpawnRequest(skill);
    expect(result).toBeUndefined();
  });

  test("default (no executionMode) returns undefined (treated as inline)", () => {
    const skill = makeSkill();
    const result = mapSkillToSpawnRequest(skill);
    expect(result).toBeUndefined();
  });

  test("caller override: force fork on a skill with no executionMode", () => {
    const skill = makeSkill();
    const result = mapSkillToSpawnRequest(skill, "fork");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.description).toBe("test-skill");
    expect(result.systemPrompt).toBe("# Instructions\n\nDo the thing.");
  });

  test("caller override: force inline on a fork skill returns undefined", () => {
    const skill = makeSkill({ executionMode: "fork" });
    const result = mapSkillToSpawnRequest(skill, "inline");
    expect(result).toBeUndefined();
  });
});

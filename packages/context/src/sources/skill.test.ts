import { describe, expect, test } from "bun:test";
import type { SkillMetadata } from "@koi/core";
import { skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { resolveSkillSource } from "./skill.js";

function createAgentWithSkills(
  skills: readonly SkillMetadata[],
): ReturnType<typeof createMockAgent> {
  const components = new Map<string, unknown>();
  for (const skill of skills) {
    components.set(skillToken(skill.name) as string, skill);
  }
  return createMockAgent({ components });
}

describe("resolveSkillSource", () => {
  test("resolves a skill by name", async () => {
    const agent = createAgentWithSkills([{ name: "research", description: "Research the web" }]);

    const result = await resolveSkillSource({ kind: "skill", name: "research" }, agent);
    expect(result.content).toContain("research");
    expect(result.content).toContain("Research the web");
  });

  test("includes tags in output when present", async () => {
    const agent = createAgentWithSkills([
      { name: "code", description: "Write code", tags: ["dev", "ai"] },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "code" }, agent);
    expect(result.content).toContain("Tags: dev, ai");
  });

  test("uses custom label when provided", async () => {
    const agent = createAgentWithSkills([{ name: "test", description: "desc" }]);

    const result = await resolveSkillSource(
      { kind: "skill", name: "test", label: "My Skill" },
      agent,
    );
    expect(result.label).toBe("My Skill");
  });

  test("uses default label with skill name", async () => {
    const agent = createAgentWithSkills([{ name: "test", description: "desc" }]);

    const result = await resolveSkillSource({ kind: "skill", name: "test" }, agent);
    expect(result.label).toBe("Skill: test");
  });

  test("rejects when skill not found", async () => {
    const agent = createAgentWithSkills([]);
    await expect(resolveSkillSource({ kind: "skill", name: "missing" }, agent)).rejects.toThrow(
      "Skill not found: missing",
    );
  });

  test("finds correct skill among multiple", async () => {
    const agent = createAgentWithSkills([
      { name: "alpha", description: "A" },
      { name: "beta", description: "B" },
      { name: "gamma", description: "C" },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "beta" }, agent);
    expect(result.content).toContain("B");
  });
});

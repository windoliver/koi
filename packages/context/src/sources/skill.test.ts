import { describe, expect, test } from "bun:test";
import type { SkillComponent } from "@koi/core";
import { skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { resolveSkillSource } from "./skill.js";

function createAgentWithSkills(
  skills: readonly SkillComponent[],
): ReturnType<typeof createMockAgent> {
  const components = new Map<string, unknown>();
  for (const skill of skills) {
    components.set(skillToken(skill.name) as string, skill);
  }
  return createMockAgent({ components });
}

describe("resolveSkillSource", () => {
  test("resolves a skill by name", async () => {
    const agent = createAgentWithSkills([
      { name: "research", description: "Research the web", content: "" },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "research" }, agent);
    expect(result.content).toContain("research");
    expect(result.content).toContain("Research the web");
  });

  test("includes content in output when present", async () => {
    const agent = createAgentWithSkills([
      {
        name: "code-review",
        description: "Reviews code",
        content: "## Instructions\n\nReview the code for security issues.",
      },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "code-review" }, agent);
    expect(result.content).toContain("## Instructions");
    expect(result.content).toContain("Review the code for security issues.");
  });

  test("omits content section when content is empty string", async () => {
    const agent = createAgentWithSkills([
      { name: "minimal", description: "Minimal skill", content: "" },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "minimal" }, agent);
    expect(result.content).toBe("Skill: minimal\nMinimal skill");
  });

  test("includes tags in output when present", async () => {
    const agent = createAgentWithSkills([
      { name: "code", description: "Write code", content: "", tags: ["dev", "ai"] },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "code" }, agent);
    expect(result.content).toContain("Tags: dev, ai");
  });

  test("content appears before tags in output", async () => {
    const agent = createAgentWithSkills([
      {
        name: "full",
        description: "Full skill",
        content: "Do things carefully.",
        tags: ["careful"],
      },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "full" }, agent);
    const contentIdx = result.content.indexOf("Do things carefully.");
    const tagsIdx = result.content.indexOf("Tags: careful");
    expect(contentIdx).toBeGreaterThan(-1);
    expect(tagsIdx).toBeGreaterThan(contentIdx);
  });

  test("uses custom label when provided", async () => {
    const agent = createAgentWithSkills([{ name: "test", description: "desc", content: "" }]);

    const result = await resolveSkillSource(
      { kind: "skill", name: "test", label: "My Skill" },
      agent,
    );
    expect(result.label).toBe("My Skill");
  });

  test("uses default label with skill name", async () => {
    const agent = createAgentWithSkills([{ name: "test", description: "desc", content: "" }]);

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
      { name: "alpha", description: "A", content: "Alpha instructions" },
      { name: "beta", description: "B", content: "Beta instructions" },
      { name: "gamma", description: "C", content: "Gamma instructions" },
    ]);

    const result = await resolveSkillSource({ kind: "skill", name: "beta" }, agent);
    expect(result.content).toContain("B");
    expect(result.content).toContain("Beta instructions");
    expect(result.content).not.toContain("Alpha instructions");
  });
});

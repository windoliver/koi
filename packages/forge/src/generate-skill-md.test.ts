import { describe, expect, test } from "bun:test";
import type { SkillMdInput } from "./generate-skill-md.js";
import { generateSkillMd } from "./generate-skill-md.js";

function baseInput(overrides?: Partial<SkillMdInput>): SkillMdInput {
  return {
    name: "my-skill",
    description: "A useful skill",
    agentId: "agent-1",
    version: "0.0.1",
    body: "# Hello\n\nThis is the skill body.",
    ...overrides,
  };
}

describe("generateSkillMd", () => {
  test("generates valid SKILL.md with all fields", () => {
    const result = generateSkillMd(baseInput({ tags: ["math", "util"] }));

    expect(result).toContain("---");
    expect(result).toContain("name: my-skill");
    expect(result).toContain("description: A useful skill");
    expect(result).toContain("author: agent-1");
    expect(result).toContain("version: 0.0.1");
    expect(result).toContain("  tags:");
    expect(result).toContain("    - math");
    expect(result).toContain("    - util");
    expect(result).toContain("# Hello\n\nThis is the skill body.");
  });

  test("starts and ends frontmatter with --- delimiters", () => {
    const result = generateSkillMd(baseInput());
    const lines = result.split("\n");
    expect(lines[0]).toBe("---");
    // Find second ---
    const secondDelimiter = lines.indexOf("---", 1);
    expect(secondDelimiter).toBeGreaterThan(0);
  });

  test("omits tags key when tags is undefined", () => {
    const result = generateSkillMd(baseInput({ tags: undefined }));
    expect(result).not.toContain("tags:");
  });

  test("omits tags key when tags is empty array", () => {
    const result = generateSkillMd(baseInput({ tags: [] }));
    expect(result).not.toContain("tags:");
  });

  test("quotes description with YAML special characters", () => {
    const result = generateSkillMd(baseInput({ description: "A skill: does things & more" }));
    expect(result).toContain('description: "A skill: does things & more"');
  });

  test("quotes description with colons", () => {
    const result = generateSkillMd(baseInput({ description: "step 1: do this" }));
    expect(result).toContain('description: "step 1: do this"');
  });

  test("escapes double quotes in description", () => {
    const result = generateSkillMd(baseInput({ description: 'A "quoted" skill' }));
    expect(result).toContain('description: "A \\"quoted\\" skill"');
  });

  test("preserves body exactly (no trimming)", () => {
    const body = "  leading spaces\n\ntrailing newline\n";
    const result = generateSkillMd(baseInput({ body }));
    expect(result).toEndWith(body);
  });

  test("body appears after frontmatter with blank line separator", () => {
    const result = generateSkillMd(baseInput());
    const parts = result.split("---");
    // parts[0] is empty (before first ---), parts[1] is frontmatter, parts[2] is body
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const afterFrontmatter = parts[2];
    expect(afterFrontmatter).toBeDefined();
    // Should start with blank line then body
    expect(afterFrontmatter?.startsWith("\n\n")).toBe(true);
  });

  test("frontmatter is parseable as YAML (basic structure check)", () => {
    const result = generateSkillMd(baseInput({ tags: ["a", "b"] }));
    const lines = result.split("\n");
    const endIdx = lines.indexOf("---", 1);
    const frontmatter = lines.slice(1, endIdx).join("\n");

    // Basic YAML structure: key: value pairs
    expect(frontmatter).toContain("name:");
    expect(frontmatter).toContain("description:");
    expect(frontmatter).toContain("metadata:");
    expect(frontmatter).toContain("  author:");
    expect(frontmatter).toContain("  version:");
    expect(frontmatter).toContain("  tags:");
  });

  test("name with special chars is quoted", () => {
    const result = generateSkillMd(baseInput({ name: "skill: special" }));
    expect(result).toContain('name: "skill: special"');
  });
});

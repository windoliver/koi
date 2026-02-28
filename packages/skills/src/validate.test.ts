import { describe, expect, test } from "bun:test";
import { validateSkillFrontmatter } from "./validate.js";

describe("validateSkillFrontmatter", () => {
  test("accepts valid minimal frontmatter", () => {
    const result = validateSkillFrontmatter({ name: "my-skill", description: "Does things" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("my-skill");
      expect(result.value.description).toBe("Does things");
    }
  });

  test("accepts all optional fields", () => {
    const result = validateSkillFrontmatter({
      name: "code-review",
      description: "Reviews code",
      license: "MIT",
      compatibility: "Claude 3.5+",
      metadata: { author: "koi-team" },
      "allowed-tools": "read_file write_file",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.license).toBe("MIT");
      expect(result.value.compatibility).toBe("Claude 3.5+");
      expect(result.value.metadata).toEqual({ author: "koi-team" });
      expect(result.value.allowedTools).toEqual(["read_file", "write_file"]);
    }
  });

  test("rejects uppercase name", () => {
    const result = validateSkillFrontmatter({ name: "MySkill", description: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects empty name", () => {
    const result = validateSkillFrontmatter({ name: "", description: "test" });
    expect(result.ok).toBe(false);
  });

  test("rejects name longer than 64 characters", () => {
    const result = validateSkillFrontmatter({ name: "a".repeat(65), description: "test" });
    expect(result.ok).toBe(false);
  });

  test("rejects name with leading hyphen", () => {
    const result = validateSkillFrontmatter({ name: "-invalid", description: "test" });
    expect(result.ok).toBe(false);
  });

  test("rejects name with trailing hyphen", () => {
    const result = validateSkillFrontmatter({ name: "invalid-", description: "test" });
    expect(result.ok).toBe(false);
  });

  test("rejects name with consecutive hyphens", () => {
    const result = validateSkillFrontmatter({ name: "my--skill", description: "test" });
    expect(result.ok).toBe(false);
  });

  test("rejects name with special characters", () => {
    const result = validateSkillFrontmatter({ name: "my_skill!", description: "test" });
    expect(result.ok).toBe(false);
  });

  test("rejects empty description", () => {
    const result = validateSkillFrontmatter({ name: "valid", description: "" });
    expect(result.ok).toBe(false);
  });

  test("rejects description longer than 1024 characters", () => {
    const result = validateSkillFrontmatter({ name: "valid", description: "x".repeat(1025) });
    expect(result.ok).toBe(false);
  });

  test("parses allowed-tools from space-delimited string", () => {
    const result = validateSkillFrontmatter({
      name: "tool-user",
      description: "Uses tools",
      "allowed-tools": "  read_file  write_file  search  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedTools).toEqual(["read_file", "write_file", "search"]);
    }
  });

  test("omits optional fields when not present", () => {
    const result = validateSkillFrontmatter({ name: "clean", description: "test" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("license" in result.value).toBe(false);
      expect("compatibility" in result.value).toBe(false);
      expect("metadata" in result.value).toBe(false);
      expect("allowedTools" in result.value).toBe(false);
    }
  });

  test("ignores unknown fields", () => {
    const result = validateSkillFrontmatter({
      name: "valid",
      description: "test",
      unknownField: "should be ignored",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts single-char name", () => {
    const result = validateSkillFrontmatter({ name: "a", description: "test" });
    expect(result.ok).toBe(true);
  });

  test("accepts name with digits", () => {
    const result = validateSkillFrontmatter({ name: "skill-v2", description: "test" });
    expect(result.ok).toBe(true);
  });

  test("rejects compatibility longer than 500 characters", () => {
    const result = validateSkillFrontmatter({
      name: "valid",
      description: "test",
      compatibility: "x".repeat(501),
    });
    expect(result.ok).toBe(false);
  });
});

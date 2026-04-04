import { describe, expect, test } from "bun:test";
import { generateMemoryToolSkillContent, MEMORY_TOOL_SKILL_CONTENT } from "./skill.js";

describe("generateMemoryToolSkillContent", () => {
  test("includes all 4 tool names", () => {
    const content = generateMemoryToolSkillContent();
    expect(content).toContain("memory_store");
    expect(content).toContain("memory_recall");
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_delete");
  });

  test("includes when to store guidance", () => {
    const content = generateMemoryToolSkillContent();
    expect(content).toContain("When to store");
    expect(content).toContain("When NOT to store");
  });

  test("includes memory types table", () => {
    const content = generateMemoryToolSkillContent();
    expect(content).toContain("user");
    expect(content).toContain("feedback");
    expect(content).toContain("project");
    expect(content).toContain("reference");
  });

  test("includes baseDir when provided", () => {
    const content = generateMemoryToolSkillContent("/home/agent/.memory");
    expect(content).toContain("/home/agent/.memory");
    expect(content).toContain("Storage location");
  });

  test("omits storage section when no baseDir", () => {
    const content = generateMemoryToolSkillContent();
    expect(content).not.toContain("Storage location");
  });
});

describe("MEMORY_TOOL_SKILL_CONTENT", () => {
  test("is a non-empty string", () => {
    expect(typeof MEMORY_TOOL_SKILL_CONTENT).toBe("string");
    expect(MEMORY_TOOL_SKILL_CONTENT.length).toBeGreaterThan(100);
  });

  test("does not contain storage section", () => {
    expect(MEMORY_TOOL_SKILL_CONTENT).not.toContain("Storage location");
  });
});

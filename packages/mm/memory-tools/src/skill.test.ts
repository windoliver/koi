import { describe, expect, test } from "bun:test";
import { generateMemoryToolSkillContent, MEMORY_TOOL_SKILL_CONTENT } from "./skill.js";

describe("generateMemoryToolSkillContent", () => {
  test("includes all 4 tool names with default prefix", () => {
    const content = generateMemoryToolSkillContent();
    expect(content).toContain("memory_store");
    expect(content).toContain("memory_recall");
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_delete");
  });

  test("uses custom prefix in tool names", () => {
    const content = generateMemoryToolSkillContent({ prefix: "m" });
    expect(content).toContain("m_store");
    expect(content).toContain("m_recall");
    expect(content).toContain("m_search");
    expect(content).toContain("m_delete");
    expect(content).not.toContain("memory_store");
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
    const content = generateMemoryToolSkillContent({ baseDir: "/home/agent/.memory" });
    expect(content).toContain("/home/agent/.memory");
    expect(content).toContain("Storage location");
  });

  test("omits storage section when no baseDir", () => {
    const content = generateMemoryToolSkillContent();
    expect(content).not.toContain("Storage location");
  });

  test("sanitizes backticks and newlines from baseDir", () => {
    const content = generateMemoryToolSkillContent({ baseDir: "/path/`inject\nnewline`/dir" });
    expect(content).not.toContain("`inject");
    expect(content).toContain("/path/injectnewline/dir");
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

// Regression tests for #1964 — type misclassification (Q85, Q86)
describe("type classification guidance (regression #1964)", () => {
  test("skill feedback examples include coding-style / work-guidance patterns", () => {
    const content = generateMemoryToolSkillContent();
    // feedback must signal it covers behavioral/style guidance ("always do X"), not just corrections
    expect(content).toMatch(/always|style|guideline|return type/i);
  });

  test("skill reference examples include person-contact pointers, not just tool URLs", () => {
    const content = generateMemoryToolSkillContent();
    // reference must cover contacts/people pointers, not only Linear/Slack tool links
    expect(content).toMatch(/contact|email/i);
  });

  test("skill type table disambiguates feedback from project with explicit markers", () => {
    const content = generateMemoryToolSkillContent();
    // The table row for feedback must distinguish it from project (ongoing work vs behavioral guidance)
    expect(content).toMatch(/feedback[^|]*\|[^|]*(?:guidance|style|always|behavior|prefer)/i);
  });

  test("skill type table disambiguates reference from user with explicit markers", () => {
    const content = generateMemoryToolSkillContent();
    // reference row must mention contact / pointer patterns
    expect(content).toMatch(/reference[^|]*\|[^|]*(?:contact|pointer|where|http|email)/i);
  });
});

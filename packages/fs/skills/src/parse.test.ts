import { describe, expect, test } from "bun:test";
import { parseSkillMd } from "./parse.js";

describe("parseSkillMd", () => {
  test("parses valid frontmatter and body", () => {
    const input = [
      "---",
      "name: my-skill",
      "description: Does things",
      "---",
      "# Body",
      "",
      "Some markdown.",
    ].join("\n");

    const result = parseSkillMd(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter).toEqual({ name: "my-skill", description: "Does things" });
      expect(result.value.body).toBe("# Body\n\nSome markdown.");
    }
  });

  test("handles empty body", () => {
    const input = "---\nname: x\n---\n";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toBe("");
    }
  });

  test("normalizes CRLF to LF", () => {
    const input = "---\r\nname: x\r\n---\r\nBody.\r\n";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter).toEqual({ name: "x" });
      expect(result.value.body).toBe("Body.");
    }
  });

  test("preserves --- in body (not confused with delimiters)", () => {
    const input = ["---", "name: test", "---", "# Title", "", "---", "", "More text."].join("\n");
    const result = parseSkillMd(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toContain("---");
      expect(result.value.body).toContain("More text.");
    }
  });

  test("returns error when no frontmatter delimiters", () => {
    const input = "# Just markdown\n\nNo frontmatter.";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("---");
    }
  });

  test("returns error when only opening delimiter", () => {
    const input = "---\nname: x\nNo closing delimiter.";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("closing");
    }
  });

  test("returns error for invalid YAML in frontmatter", () => {
    const input = "---\n[invalid yaml: {{{\n---\nBody.";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("YAML");
    }
  });

  test("returns error when frontmatter is an array", () => {
    const input = "---\n- item1\n- item2\n---\nBody.";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("mapping");
    }
  });

  test("returns error when frontmatter is a scalar", () => {
    const input = "---\njust a string\n---\nBody.";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("mapping");
    }
  });

  test("handles frontmatter with extra whitespace around delimiters", () => {
    const input = "---\nname: spaced\ndescription: test\n---\n  \n  Body with leading spaces.";
    const result = parseSkillMd(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter.name).toBe("spaced");
    }
  });
});

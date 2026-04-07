import { describe, expect, test } from "bun:test";
import { parseSkillMd } from "./parse.js";

const VALID_MD = `---
name: my-skill
description: Does something useful.
---

# My Skill

This is the body.
`;

describe("parseSkillMd", () => {
  test("parses valid SKILL.md into frontmatter + body", () => {
    const result = parseSkillMd(VALID_MD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.name).toBe("my-skill");
    expect(result.value.frontmatter.description).toBe("Does something useful.");
    expect(result.value.body).toContain("# My Skill");
    expect(result.value.body).toContain("This is the body.");
  });

  test("body does not contain frontmatter block", () => {
    const result = parseSkillMd(VALID_MD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).not.toContain("---");
    expect(result.value.body).not.toContain("name: my-skill");
  });

  test("returns VALIDATION error when opening --- is missing", () => {
    const result = parseSkillMd("name: foo\n---\n\nbody");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context?.errorKind).toBe("MISSING_FRONTMATTER");
  });

  test("returns VALIDATION error when closing --- is missing", () => {
    const result = parseSkillMd("---\nname: foo\n\nbody");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context?.errorKind).toBe("MISSING_FRONTMATTER_CLOSE");
  });

  test("returns VALIDATION error for invalid YAML", () => {
    const result = parseSkillMd("---\nname: [unclosed\n---\n\nbody");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context?.errorKind).toBe("INVALID_YAML");
  });

  test("returns VALIDATION error when frontmatter is an array not object", () => {
    const result = parseSkillMd("---\n- item1\n- item2\n---\n\nbody");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context?.errorKind).toBe("INVALID_FRONTMATTER_TYPE");
  });

  test("handles CRLF line endings", () => {
    const crlf = "---\r\nname: foo\r\ndescription: bar\r\n---\r\n\r\nbody";
    const result = parseSkillMd(crlf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.name).toBe("foo");
  });

  test("includes filePath in error message when provided", () => {
    const result = parseSkillMd("no frontmatter", "/path/to/SKILL.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("/path/to/SKILL.md");
  });

  test("parses frontmatter with allowed-tools as string", () => {
    const md = "---\nname: s\ndescription: d\nallowed-tools: read_file write_file\n---\n\nbody";
    const result = parseSkillMd(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter["allowed-tools"]).toBe("read_file write_file");
  });

  test("parses frontmatter with nested requires object", () => {
    const md = "---\nname: s\ndescription: d\nrequires:\n  bins:\n    - git\n---\n\nbody";
    const result = parseSkillMd(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const requires = result.value.frontmatter.requires as Record<string, unknown>;
    expect(Array.isArray(requires.bins)).toBe(true);
  });

  test("handles empty body", () => {
    const result = parseSkillMd("---\nname: s\ndescription: d\n---\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBe("");
  });
});

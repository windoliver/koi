/**
 * Unit tests for the Markdown frontmatter parser.
 */

import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  test("parses valid frontmatter + body", () => {
    const content = `---
name: researcher
description: Deep research agent
---

You are a research specialist.`;

    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta).toEqual({
      name: "researcher",
      description: "Deep research agent",
    });
    expect(result.value.body).toBe("You are a research specialist.");
  });

  test("returns raw content as body when no frontmatter delimiters", () => {
    const content = "Just a plain markdown file with no frontmatter.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta).toEqual({});
    expect(result.value.body).toBe(content);
  });

  test("handles frontmatter-only with no body", () => {
    const content = `---
name: minimal
description: No body
---`;

    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta).toEqual({ name: "minimal", description: "No body" });
    expect(result.value.body).toBe("");
  });

  test("returns error for malformed YAML in frontmatter", () => {
    const content = `---
name: bad
  invalid: yaml: here: [
---

Body text.`;

    const result = parseFrontmatter(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Malformed YAML");
  });

  test("handles Windows line endings (CRLF)", () => {
    const content = "---\r\nname: win-agent\r\ndescription: Windows style\r\n---\r\n\r\nBody here.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta).toEqual({ name: "win-agent", description: "Windows style" });
    expect(result.value.body).toBe("Body here.");
  });

  test("empty frontmatter (null YAML) returns empty meta", () => {
    const content = "---\n\n---\n\nBody after empty frontmatter.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta).toEqual({});
    expect(result.value.body).toBe("Body after empty frontmatter.");
  });

  test("trailing whitespace on delimiter lines", () => {
    const content = "---   \nname: test\n---\t\n\nBody.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.name).toBe("test");
    expect(result.value.body).toBe("Body.");
  });

  test("YAML scalar in frontmatter returns error", () => {
    const content = "---\njust a string\n---\n\nBody.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("mapping");
  });

  test("YAML array in frontmatter returns error", () => {
    const content = "---\n- item1\n- item2\n---\n\nBody.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("mapping");
  });

  test("nested YAML objects pass through", () => {
    const content =
      "---\nname: test\nmetadata:\n  key: value\n  nested:\n    deep: true\n---\n\nBody.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.name).toBe("test");
    const metadata = result.value.meta.metadata as Record<string, unknown>;
    expect(metadata.key).toBe("value");
  });

  test("YAML with special characters in values", () => {
    const content =
      '---\nname: "test: agent"\ndescription: "A test with: colons & special chars"\n---\n\nBody.';
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.name).toBe("test: agent");
    expect(result.value.meta.description).toBe("A test with: colons & special chars");
  });
});

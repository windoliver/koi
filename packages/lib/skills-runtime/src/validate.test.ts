import { describe, expect, test } from "bun:test";
import { validateFrontmatter } from "./validate.js";

describe("validateFrontmatter", () => {
  test("accepts minimal valid frontmatter", () => {
    const result = validateFrontmatter({ name: "my-skill", description: "Does X." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("my-skill");
    expect(result.value.description).toBe("Does X.");
  });

  test("returns VALIDATION error when name is missing", () => {
    const result = validateFrontmatter({ description: "No name" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error when description is missing", () => {
    const result = validateFrontmatter({ name: "foo" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error for empty name", () => {
    const result = validateFrontmatter({ name: "", description: "d" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  // Decision 8A: Zod .transform() normalizes allowed-tools → allowedTools

  test("transforms allowed-tools string to allowedTools array", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      "allowed-tools": "read_file write_file",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedTools).toEqual(["read_file", "write_file"]);
  });

  test("transforms allowed-tools array to allowedTools array", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      "allowed-tools": ["read_file", "write_file"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedTools).toEqual(["read_file", "write_file"]);
  });

  test("allowedTools is undefined when allowed-tools is absent", () => {
    const result = validateFrontmatter({ name: "s", description: "d" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedTools).toBeUndefined();
  });

  test("handles single allowed-tool string without spaces", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      "allowed-tools": "read_file",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedTools).toEqual(["read_file"]);
  });

  test("accepts license and compatibility fields", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      license: "MIT",
      compatibility: ">=1.0.0",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.license).toBe("MIT");
    expect(result.value.compatibility).toBe(">=1.0.0");
  });

  test("accepts requires object with bins and env", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      requires: { bins: ["git"], env: ["GITHUB_TOKEN"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requires?.bins).toEqual(["git"]);
    expect(result.value.requires?.env).toEqual(["GITHUB_TOKEN"]);
  });

  test("collects extra string fields into metadata", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      author: "Alice",
      version: "1.2.3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata?.author).toBe("Alice");
    expect(result.value.metadata?.version).toBe("1.2.3");
  });

  test("metadata is undefined when no extra fields present", () => {
    const result = validateFrontmatter({ name: "s", description: "d" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toBeUndefined();
  });

  test("includes filePath in error message when provided", () => {
    const result = validateFrontmatter({ description: "no name" }, "/path/SKILL.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("/path/SKILL.md");
  });

  // ---------------------------------------------------------------------------
  // Execution mode tests
  // ---------------------------------------------------------------------------

  test('execution: "inline" → executionMode is "inline"', () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      execution: "inline",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionMode).toBe("inline");
  });

  test('execution: "fork" → executionMode is "fork"', () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      execution: "fork",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionMode).toBe("fork");
  });

  test("no execution field → executionMode is undefined (defaults to inline at runtime)", () => {
    const result = validateFrontmatter({ name: "s", description: "d" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionMode).toBeUndefined();
  });

  test("invalid execution value → executionMode is undefined (silently ignored)", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      execution: "invalid-mode",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Invalid values are silently ignored — treated as no execution field
    expect(result.value.executionMode).toBeUndefined();
  });

  test("execution field is not collected into metadata", () => {
    const result = validateFrontmatter({
      name: "s",
      description: "d",
      execution: "fork",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // execution is a known key — should NOT appear in metadata
    expect(result.value.metadata).toBeUndefined();
  });
});

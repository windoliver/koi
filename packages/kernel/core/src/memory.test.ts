import { describe, expect, test } from "bun:test";
import type { MemoryFrontmatter, MemoryIndexEntry } from "./memory.js";
import {
  ALL_MEMORY_TYPES,
  formatMemoryIndexEntry,
  isMemoryType,
  MEMORY_INDEX_MAX_LINES,
  memoryRecordId,
  parseMemoryFrontmatter,
  parseMemoryIndexEntry,
  serializeMemoryFrontmatter,
  validateMemoryRecordInput,
} from "./memory.js";

// ---------------------------------------------------------------------------
// memoryRecordId branded constructor
// ---------------------------------------------------------------------------

describe("memoryRecordId", () => {
  test("creates a branded MemoryRecordId from a string", () => {
    const id = memoryRecordId("mem-1");
    expect(id as string).toBe("mem-1");
  });
});

// ---------------------------------------------------------------------------
// isMemoryType
// ---------------------------------------------------------------------------

describe("isMemoryType", () => {
  test("accepts all valid memory types", () => {
    for (const t of ALL_MEMORY_TYPES) {
      expect(isMemoryType(t)).toBe(true);
    }
  });

  test("rejects unknown strings", () => {
    expect(isMemoryType("unknown")).toBe(false);
    expect(isMemoryType("")).toBe(false);
    expect(isMemoryType("User")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isMemoryType(42)).toBe(false);
    expect(isMemoryType(null)).toBe(false);
    expect(isMemoryType(undefined)).toBe(false);
    expect(isMemoryType({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ALL_MEMORY_TYPES
// ---------------------------------------------------------------------------

describe("ALL_MEMORY_TYPES", () => {
  test("contains exactly 4 types", () => {
    expect(ALL_MEMORY_TYPES).toHaveLength(4);
  });

  test("contains user, feedback, project, reference", () => {
    expect(ALL_MEMORY_TYPES).toContain("user");
    expect(ALL_MEMORY_TYPES).toContain("feedback");
    expect(ALL_MEMORY_TYPES).toContain("project");
    expect(ALL_MEMORY_TYPES).toContain("reference");
  });
});

// ---------------------------------------------------------------------------
// parseMemoryFrontmatter
// ---------------------------------------------------------------------------

describe("parseMemoryFrontmatter", () => {
  test("parses valid frontmatter with content", () => {
    const raw = [
      "---",
      "name: user role",
      "description: user is a data scientist",
      "type: user",
      "---",
      "",
      "The user is a data scientist focused on ML.",
    ].join("\n");

    const result = parseMemoryFrontmatter(raw);
    expect(result).toBeDefined();
    expect(result?.frontmatter.name).toBe("user role");
    expect(result?.frontmatter.description).toBe("user is a data scientist");
    expect(result?.frontmatter.type).toBe("user");
    expect(result?.content).toBe("\nThe user is a data scientist focused on ML.");
  });

  test("parses frontmatter with multiline content", () => {
    const raw = [
      "---",
      "name: testing feedback",
      "description: integration tests must hit real DB",
      "type: feedback",
      "---",
      "",
      "Integration tests must hit a real database.",
      "",
      "**Why:** prior incident where mock/prod divergence masked a broken migration.",
      "**How to apply:** always use test DB, never mocks for data layer tests.",
    ].join("\n");

    const result = parseMemoryFrontmatter(raw);
    expect(result).toBeDefined();
    expect(result?.frontmatter.type).toBe("feedback");
    expect(result?.content).toContain("**Why:**");
    expect(result?.content).toContain("**How to apply:**");
  });

  test("returns undefined for missing frontmatter delimiters", () => {
    expect(parseMemoryFrontmatter("no frontmatter here")).toBeUndefined();
  });

  test("returns undefined for missing closing delimiter", () => {
    const raw = "---\nname: test\ndescription: test\ntype: user\n";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("returns undefined for missing required field (name)", () => {
    const raw = "---\ndescription: test\ntype: user\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("returns undefined for missing required field (description)", () => {
    const raw = "---\nname: test\ntype: user\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("returns undefined for missing required field (type)", () => {
    const raw = "---\nname: test\ndescription: test\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("returns undefined for invalid memory type", () => {
    const raw = "---\nname: test\ndescription: test\ntype: invalid\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("handles leading whitespace before frontmatter", () => {
    const raw = "\n  ---\nname: test\ndescription: test desc\ntype: project\n---\ncontent";
    const result = parseMemoryFrontmatter(raw);
    expect(result).toBeDefined();
    expect(result?.frontmatter.type).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// serializeMemoryFrontmatter
// ---------------------------------------------------------------------------

describe("serializeMemoryFrontmatter", () => {
  test("produces valid frontmatter markdown", () => {
    const fm: MemoryFrontmatter = {
      name: "test memory",
      description: "a test description",
      type: "reference",
    };
    const result = serializeMemoryFrontmatter(fm, "The body content.");

    expect(result).toContain("---");
    expect(result).toContain("name: test memory");
    expect(result).toContain("description: a test description");
    expect(result).toContain("type: reference");
    expect(result).toContain("The body content.");
  });

  test("roundtrips with parseMemoryFrontmatter", () => {
    const fm: MemoryFrontmatter = {
      name: "roundtrip test",
      description: "testing roundtrip serialization",
      type: "feedback",
    };
    const content = "Rule: always use typed errors.\n\n**Why:** untyped errors lose context.";
    const serialized = serializeMemoryFrontmatter(fm, content);
    const parsed = parseMemoryFrontmatter(serialized);

    expect(parsed).toBeDefined();
    expect(parsed?.frontmatter).toEqual(fm);
    expect(parsed?.content).toContain(content);
  });
});

// ---------------------------------------------------------------------------
// validateMemoryRecordInput
// ---------------------------------------------------------------------------

describe("validateMemoryRecordInput", () => {
  test("returns empty array for valid input", () => {
    const errors = validateMemoryRecordInput({
      name: "valid name",
      description: "valid description",
      type: "user",
      content: "valid content",
    });
    expect(errors).toEqual([]);
  });

  test("rejects missing name", () => {
    const errors = validateMemoryRecordInput({
      description: "desc",
      type: "user",
      content: "content",
    });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  test("rejects empty name", () => {
    const errors = validateMemoryRecordInput({
      name: "  ",
      description: "desc",
      type: "user",
      content: "content",
    });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  test("rejects missing description", () => {
    const errors = validateMemoryRecordInput({
      name: "name",
      type: "user",
      content: "content",
    });
    expect(errors.some((e) => e.field === "description")).toBe(true);
  });

  test("rejects invalid type", () => {
    const errors = validateMemoryRecordInput({
      name: "name",
      description: "desc",
      type: "invalid",
      content: "content",
    });
    expect(errors.some((e) => e.field === "type")).toBe(true);
  });

  test("rejects missing content", () => {
    const errors = validateMemoryRecordInput({
      name: "name",
      description: "desc",
      type: "user",
    });
    expect(errors.some((e) => e.field === "content")).toBe(true);
  });

  test("returns multiple errors for multiple invalid fields", () => {
    const errors = validateMemoryRecordInput({});
    expect(errors.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// formatMemoryIndexEntry / parseMemoryIndexEntry
// ---------------------------------------------------------------------------

describe("formatMemoryIndexEntry", () => {
  test("formats as markdown link with hook", () => {
    const entry: MemoryIndexEntry = {
      title: "User Role",
      filePath: "user_role.md",
      hook: "user is a data scientist focused on ML",
    };
    expect(formatMemoryIndexEntry(entry)).toBe(
      "- [User Role](user_role.md) — user is a data scientist focused on ML",
    );
  });
});

describe("parseMemoryIndexEntry", () => {
  test("parses a valid index line", () => {
    const line = "- [User Role](user_role.md) — user is a data scientist";
    const entry = parseMemoryIndexEntry(line);
    expect(entry).toBeDefined();
    expect(entry?.title).toBe("User Role");
    expect(entry?.filePath).toBe("user_role.md");
    expect(entry?.hook).toBe("user is a data scientist");
  });

  test("returns undefined for malformed line", () => {
    expect(parseMemoryIndexEntry("not a valid line")).toBeUndefined();
    expect(parseMemoryIndexEntry("- missing link")).toBeUndefined();
    expect(parseMemoryIndexEntry("")).toBeUndefined();
  });

  test("roundtrips with formatMemoryIndexEntry", () => {
    const entry: MemoryIndexEntry = {
      title: "DB Feedback",
      filePath: "feedback_db.md",
      hook: "integration tests must hit real DB",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(formatted);
    expect(parsed).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// MEMORY_INDEX_MAX_LINES constant
// ---------------------------------------------------------------------------

describe("MEMORY_INDEX_MAX_LINES", () => {
  test("is 200", () => {
    expect(MEMORY_INDEX_MAX_LINES).toBe(200);
  });
});

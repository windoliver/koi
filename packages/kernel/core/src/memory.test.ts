import { describe, expect, test } from "bun:test";
import type { MemoryFrontmatter, MemoryIndexEntry } from "./memory.js";
import {
  ALL_MEMORY_TYPES,
  formatMemoryIndexEntry,
  hasFrontmatterUnsafeChars,
  isMemoryType,
  MEMORY_INDEX_MAX_LINES,
  memoryRecordId,
  parseMemoryFrontmatter,
  parseMemoryIndexEntry,
  serializeMemoryFrontmatter,
  validateMemoryFilePath,
  validateMemoryRecordInput,
} from "./memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts a value is defined and returns it typed. Avoids `!` lint violations. */
function defined<T>(value: T | undefined, msg = "expected defined"): T {
  if (value === undefined) throw new Error(msg);
  return value;
}

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
    expect(result?.content).toBe("The user is a data scientist focused on ML.");
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
    const parsed = parseMemoryFrontmatter(defined(serialized));

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
    const parsed = parseMemoryIndexEntry(defined(formatted));
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

// ---------------------------------------------------------------------------
// hasFrontmatterUnsafeChars
// ---------------------------------------------------------------------------

describe("hasFrontmatterUnsafeChars", () => {
  test("returns false for safe strings", () => {
    expect(hasFrontmatterUnsafeChars("hello world")).toBe(false);
    expect(hasFrontmatterUnsafeChars("colons: are fine")).toBe(false);
  });

  test("returns true for strings with newlines", () => {
    expect(hasFrontmatterUnsafeChars("line1\nline2")).toBe(true);
    expect(hasFrontmatterUnsafeChars("line1\r\nline2")).toBe(true);
    expect(hasFrontmatterUnsafeChars("line1\rline2")).toBe(true);
  });

  test("returns true for strings with control characters", () => {
    expect(hasFrontmatterUnsafeChars("null\x00char")).toBe(true);
    expect(hasFrontmatterUnsafeChars("bell\x07char")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: frontmatter roundtrip with hostile input
// ---------------------------------------------------------------------------

describe("serializeMemoryFrontmatter (adversarial)", () => {
  test("sanitizes newlines in name field", () => {
    const fm: MemoryFrontmatter = {
      name: "injected\ntype: project\nevil: true",
      description: "safe description",
      type: "user",
    };
    const serialized = serializeMemoryFrontmatter(fm, "body");
    const parsed = parseMemoryFrontmatter(defined(serialized));

    expect(parsed).toBeDefined();
    // The injected lines should be collapsed into the name, not create new fields
    expect(parsed?.frontmatter.type).toBe("user");
    expect(parsed?.frontmatter.name).toContain("injected");
    expect(parsed?.frontmatter.name).not.toContain("\n");
  });

  test("sanitizes newlines in description field", () => {
    const fm: MemoryFrontmatter = {
      name: "test",
      description: "line1\ntype: project\ninjected: yes",
      type: "feedback",
    };
    const serialized = serializeMemoryFrontmatter(fm, "body");
    const parsed = parseMemoryFrontmatter(defined(serialized));

    expect(parsed).toBeDefined();
    expect(parsed?.frontmatter.type).toBe("feedback");
    expect(parsed?.frontmatter.description).not.toContain("\n");
  });

  test("roundtrips field values with colons", () => {
    const fm: MemoryFrontmatter = {
      name: "key: value: nested",
      description: "has: colons: everywhere",
      type: "reference",
    };
    const serialized = serializeMemoryFrontmatter(fm, "content");
    const parsed = parseMemoryFrontmatter(defined(serialized));

    expect(parsed).toBeDefined();
    expect(parsed?.frontmatter.name).toBe("key: value: nested");
    expect(parsed?.frontmatter.description).toBe("has: colons: everywhere");
  });

  test("strips control characters from fields", () => {
    const fm: MemoryFrontmatter = {
      name: "test\x00name\x07here",
      description: "desc\x01ription",
      type: "user",
    };
    const serialized = serializeMemoryFrontmatter(fm, "body");
    const parsed = parseMemoryFrontmatter(defined(serialized));

    expect(parsed).toBeDefined();
    expect(parsed?.frontmatter.name).toBe("testnamehere");
    expect(parsed?.frontmatter.description).toBe("description");
  });

  test("handles --- delimiter in field values without breaking parse", () => {
    const fm: MemoryFrontmatter = {
      name: "name with --- dashes",
      description: "description",
      type: "project",
    };
    const serialized = serializeMemoryFrontmatter(fm, "body");
    const parsed = parseMemoryFrontmatter(defined(serialized));

    expect(parsed).toBeDefined();
    expect(parsed?.frontmatter.name).toBe("name with --- dashes");
  });

  test("handles CRLF newlines in fields", () => {
    const fm: MemoryFrontmatter = {
      name: "windows\r\nstyle",
      description: "also\r\nhere",
      type: "user",
    };
    const serialized = serializeMemoryFrontmatter(fm, "body");
    const parsed = parseMemoryFrontmatter(defined(serialized));

    expect(parsed).toBeDefined();
    expect(parsed?.frontmatter.name).toBe("windows style");
    expect(parsed?.frontmatter.description).toBe("also here");
  });
});

// ---------------------------------------------------------------------------
// Adversarial: index entry roundtrip with Markdown metacharacters
// ---------------------------------------------------------------------------

describe("formatMemoryIndexEntry / parseMemoryIndexEntry (adversarial)", () => {
  test("roundtrips title with brackets", () => {
    const entry: MemoryIndexEntry = {
      title: "Config [v2]",
      filePath: "config_v2.md",
      hook: "v2 config reference",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toEqual(entry);
  });

  test("roundtrips file path with parentheses", () => {
    const entry: MemoryIndexEntry = {
      title: "Test Entry",
      filePath: "path (copy).md",
      hook: "a hook",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toEqual(entry);
  });

  test("roundtrips title with multiple brackets", () => {
    const entry: MemoryIndexEntry = {
      title: "[important] [urgent]",
      filePath: "important.md",
      hook: "tagged memory",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toEqual(entry);
  });

  test("roundtrips hook containing em dash", () => {
    const entry: MemoryIndexEntry = {
      title: "Test",
      filePath: "test.md",
      hook: "first part — second part",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    // The hook captures everything after the first " — ", including embedded em dashes
    expect(parsed).toBeDefined();
    expect(parsed?.title).toBe("Test");
    expect(parsed?.hook).toBe("first part — second part");
  });

  test("rejects file path already containing percent-encoded sequences", () => {
    const entry: MemoryIndexEntry = {
      title: "Encoded Path",
      filePath: "foo%28bar%29.md",
      hook: "path with percent-encoded parens",
    };
    // Paths with percent-encoded chars are rejected — no encoding ambiguity
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });

  test("newlines in hook are stripped to prevent line injection", () => {
    const entry: MemoryIndexEntry = {
      title: "Safe",
      filePath: "safe.md",
      hook: "first\n- [Injected](evil.md) — boom",
    };
    const formatted = formatMemoryIndexEntry(entry);
    // Must be exactly one line
    expect(defined(formatted).split("\n")).toHaveLength(1);
    // Must roundtrip (with sanitized hook)
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toBeDefined();
    expect(parsed?.hook).not.toContain("\n");
    expect(parsed?.title).toBe("Safe");
  });

  test("newlines in title are stripped to prevent line injection", () => {
    const entry: MemoryIndexEntry = {
      title: "line1\nline2",
      filePath: "test.md",
      hook: "a hook",
    };
    const formatted = formatMemoryIndexEntry(entry);
    expect(defined(formatted).split("\n")).toHaveLength(1);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toBeDefined();
    expect(parsed?.title).toBe("line1 line2");
  });

  test("newlines in filePath are stripped to prevent line injection", () => {
    const entry: MemoryIndexEntry = {
      title: "Test",
      filePath: "path\nevil.md",
      hook: "a hook",
    };
    const formatted = formatMemoryIndexEntry(entry);
    expect(defined(formatted).split("\n")).toHaveLength(1);
  });

  test("roundtrips title ending with backslash", () => {
    const entry: MemoryIndexEntry = {
      title: "path slash\\",
      filePath: "safe.md",
      hook: "keeps trailing slash in title",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toEqual(entry);
  });

  test("roundtrips title containing backslash before closing bracket", () => {
    const entry: MemoryIndexEntry = {
      title: "literal \\] sequence",
      filePath: "safe.md",
      hook: "keeps escaped-bracket-like text",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: frontmatter delimiter strictness
// ---------------------------------------------------------------------------

describe("parseMemoryFrontmatter (adversarial delimiters)", () => {
  test("rejects ---- as opener (too many dashes)", () => {
    const raw = "----\nname: test\ndescription: test\ntype: user\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("rejects ---x as opener (trailing chars)", () => {
    const raw = "---x\nname: test\ndescription: test\ntype: user\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("rejects --- followed by non-newline text", () => {
    const raw = "--- yaml\nname: test\ndescription: test\ntype: user\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("accepts exact --- followed by newline", () => {
    const raw = "---\nname: valid\ndescription: valid desc\ntype: user\n---\ncontent";
    const result = parseMemoryFrontmatter(raw);
    expect(result).toBeDefined();
    expect(result?.frontmatter.name).toBe("valid");
  });

  test("rejects duplicate keys (type overwrite attack)", () => {
    const raw = "---\nname: test\ndescription: desc\ntype: user\ntype: project\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("rejects duplicate name key", () => {
    const raw = "---\nname: first\nname: second\ndescription: desc\ntype: user\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("rejects unknown keys in frontmatter block", () => {
    const raw = "---\nname: test\ndescription: desc\ntype: user\nevil: injected\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("rejects non-key-value lines in frontmatter block", () => {
    const raw = "---\nname: test\nsome random text\ndescription: desc\ntype: user\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("rejects frontmatter with body text before closing delimiter", () => {
    // Simulates a partially written file where body leaks into frontmatter
    const raw = "---\nname: test\ndescription: desc\ntype: user\nThis is body text\n---\ncontent";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adversarial: index path backslash handling
// ---------------------------------------------------------------------------

describe("formatMemoryIndexEntry / parseMemoryIndexEntry (backslash paths)", () => {
  test("normalizes backslashes to forward slashes", () => {
    const entry: MemoryIndexEntry = {
      title: "Test",
      filePath: "a\\b\\c.md",
      hook: "a hook",
    };
    const formatted = formatMemoryIndexEntry(entry);
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toBeDefined();
    // Backslashes normalized to forward slashes
    expect(parsed?.filePath).toBe("a/b/c.md");
  });

  test("roundtrips Windows-style path after normalization", () => {
    const entry: MemoryIndexEntry = {
      title: "Windows Memory",
      filePath: "memories\\user_role.md",
      hook: "user role info",
    };
    const formatted = formatMemoryIndexEntry(entry);
    expect(formatted).toBeDefined();
    expect(formatted).not.toContain("\\");
    const parsed = parseMemoryIndexEntry(defined(formatted));
    expect(parsed).toBeDefined();
    expect(parsed?.filePath).toBe("memories/user_role.md");
  });
});

// ---------------------------------------------------------------------------
// validateMemoryFilePath
// ---------------------------------------------------------------------------

describe("validateMemoryFilePath", () => {
  test("accepts valid relative .md path", () => {
    expect(validateMemoryFilePath("user_role.md")).toBeUndefined();
    expect(validateMemoryFilePath("memories/feedback.md")).toBeUndefined();
  });

  test("rejects empty path", () => {
    expect(validateMemoryFilePath("")).toBeDefined();
    expect(validateMemoryFilePath("  ")).toBeDefined();
  });

  test("rejects absolute paths", () => {
    expect(validateMemoryFilePath("/etc/passwd.md")).toBeDefined();
    expect(validateMemoryFilePath("/memories/test.md")).toBeDefined();
  });

  test("rejects drive letter paths", () => {
    expect(validateMemoryFilePath("C:\\memories\\test.md")).toBeDefined();
    expect(validateMemoryFilePath("D:test.md")).toBeDefined();
  });

  test("rejects path traversal", () => {
    expect(validateMemoryFilePath("../../secret.md")).toBeDefined();
    expect(validateMemoryFilePath("memories/../../../etc/passwd.md")).toBeDefined();
  });

  test("rejects percent-encoded path traversal", () => {
    expect(validateMemoryFilePath("%2e%2e/secret.md")).toBeDefined();
    expect(validateMemoryFilePath("%2e%2e%2f%2e%2e%2fsecret.md")).toBeDefined();
    expect(validateMemoryFilePath("foo/%2e%2e/bar/secret.md")).toBeDefined();
  });

  test("rejects percent-encoded absolute path", () => {
    expect(validateMemoryFilePath("%2fetc/passwd.md")).toBeDefined();
  });

  test("rejects double-encoded traversal", () => {
    expect(validateMemoryFilePath("%252e%252e%252fsecret.md")).toBeDefined();
    expect(validateMemoryFilePath("%252e%252e/secret.md")).toBeDefined();
  });

  test("rejects double-encoded absolute path", () => {
    expect(validateMemoryFilePath("%252fetc/passwd.md")).toBeDefined();
  });

  test("rejects non-.md extensions", () => {
    expect(validateMemoryFilePath("test.txt")).toBeDefined();
    expect(validateMemoryFilePath("test.json")).toBeDefined();
    expect(validateMemoryFilePath("test")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Adversarial: empty body rejection
// ---------------------------------------------------------------------------

describe("parseMemoryFrontmatter (empty body)", () => {
  test("rejects empty body after closing delimiter", () => {
    const raw = "---\nname: test\ndescription: desc\ntype: user\n---\n";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("rejects whitespace-only body", () => {
    const raw = "---\nname: test\ndescription: desc\ntype: user\n---\n   \n  \n";
    expect(parseMemoryFrontmatter(raw)).toBeUndefined();
  });

  test("accepts non-empty body", () => {
    const raw = "---\nname: test\ndescription: desc\ntype: user\n---\n\nactual content";
    const result = parseMemoryFrontmatter(raw);
    expect(result).toBeDefined();
    expect(result?.content).toBe("actual content");
  });
});

// ---------------------------------------------------------------------------
// Adversarial: content roundtrip with leading blank lines
// ---------------------------------------------------------------------------

describe("serializeMemoryFrontmatter / parseMemoryFrontmatter (content roundtrip)", () => {
  test("preserves content with leading blank line", () => {
    const fm: MemoryFrontmatter = { name: "t", description: "d", type: "user" };
    const content = "\nleading blank line";
    const serialized = serializeMemoryFrontmatter(fm, content);
    const parsed = parseMemoryFrontmatter(defined(serialized));
    expect(parsed?.content).toBe(content);
  });

  test("preserves content with multiple leading blank lines", () => {
    const fm: MemoryFrontmatter = { name: "t", description: "d", type: "user" };
    const content = "\n\n\nthree leading blanks";
    const serialized = serializeMemoryFrontmatter(fm, content);
    const parsed = parseMemoryFrontmatter(defined(serialized));
    expect(parsed?.content).toBe(content);
  });

  test("preserves content without leading blank lines", () => {
    const fm: MemoryFrontmatter = { name: "t", description: "d", type: "user" };
    const content = "no leading blank";
    const serialized = serializeMemoryFrontmatter(fm, content);
    const parsed = parseMemoryFrontmatter(defined(serialized));
    expect(parsed?.content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: type injection in serializer
// ---------------------------------------------------------------------------

describe("serializeMemoryFrontmatter (type validation)", () => {
  test("rejects invalid type at runtime", () => {
    const fm = { name: "t", description: "d", type: "invalid" as "user" };
    expect(serializeMemoryFrontmatter(fm, "content")).toBeUndefined();
  });

  test("rejects newline-injected type at runtime", () => {
    const fm = { name: "t", description: "d", type: "user\nevil: yes" as "user" };
    expect(serializeMemoryFrontmatter(fm, "content")).toBeUndefined();
  });

  test("accepts valid type", () => {
    const fm: MemoryFrontmatter = { name: "t", description: "d", type: "feedback" };
    expect(serializeMemoryFrontmatter(fm, "content")).toBeDefined();
  });

  test("rejects empty content", () => {
    const fm: MemoryFrontmatter = { name: "t", description: "d", type: "user" };
    expect(serializeMemoryFrontmatter(fm, "")).toBeUndefined();
  });

  test("rejects whitespace-only content", () => {
    const fm: MemoryFrontmatter = { name: "t", description: "d", type: "user" };
    expect(serializeMemoryFrontmatter(fm, "   \n  \n")).toBeUndefined();
  });

  test("rejects name that becomes empty after sanitization", () => {
    const fm = { name: "\x00\x01\x02", description: "ok", type: "user" as const };
    expect(serializeMemoryFrontmatter(fm, "content")).toBeUndefined();
  });

  test("rejects description that becomes empty after sanitization", () => {
    const fm = { name: "ok", description: "\x00\x07", type: "user" as const };
    expect(serializeMemoryFrontmatter(fm, "content")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adversarial: CRLF file parsing
// ---------------------------------------------------------------------------

describe("parseMemoryFrontmatter (CRLF)", () => {
  test("parses fully CRLF-encoded memory file", () => {
    const raw =
      "---\r\nname: test\r\ndescription: desc\r\ntype: user\r\n---\r\n\r\nCRLF content here.";
    const result = parseMemoryFrontmatter(raw);
    expect(result).toBeDefined();
    expect(result?.frontmatter.name).toBe("test");
    expect(result?.frontmatter.description).toBe("desc");
    expect(result?.frontmatter.type).toBe("user");
    expect(result?.content).toBe("CRLF content here.");
  });

  test("parses mixed LF/CRLF file", () => {
    const raw = "---\r\nname: mixed\ndescription: line endings\r\ntype: project\n---\r\n\ncontent";
    const result = parseMemoryFrontmatter(raw);
    expect(result).toBeDefined();
    expect(result?.frontmatter.name).toBe("mixed");
    expect(result?.frontmatter.type).toBe("project");
    expect(result?.content).toBe("content");
  });

  test("roundtrips LF-serialized content through CRLF-aware parser", () => {
    const fm: MemoryFrontmatter = { name: "t", description: "d", type: "user" };
    const serialized = serializeMemoryFrontmatter(fm, "body");
    const parsed = parseMemoryFrontmatter(defined(serialized));
    expect(parsed?.content).toBe("body");
  });
});

// ---------------------------------------------------------------------------
// Adversarial: index path validation in format/parse
// ---------------------------------------------------------------------------

describe("formatMemoryIndexEntry (path validation)", () => {
  test("rejects path traversal", () => {
    const entry: MemoryIndexEntry = {
      title: "Evil",
      filePath: "../../secret.md",
      hook: "steal data",
    };
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });

  test("rejects absolute path", () => {
    const entry: MemoryIndexEntry = {
      title: "Evil",
      filePath: "/etc/passwd.md",
      hook: "steal data",
    };
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });

  test("rejects non-.md path", () => {
    const entry: MemoryIndexEntry = {
      title: "Evil",
      filePath: "config.json",
      hook: "wrong extension",
    };
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });

  test("accepts valid relative .md path", () => {
    const entry: MemoryIndexEntry = {
      title: "Valid",
      filePath: "memories/user.md",
      hook: "valid path",
    };
    expect(formatMemoryIndexEntry(entry)).toBeDefined();
  });

  test("rejects empty title after sanitization", () => {
    const entry: MemoryIndexEntry = {
      title: "",
      filePath: "test.md",
      hook: "a hook",
    };
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });

  test("rejects whitespace-only title after sanitization", () => {
    const entry: MemoryIndexEntry = {
      title: "   ",
      filePath: "test.md",
      hook: "a hook",
    };
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });

  test("rejects empty hook after sanitization", () => {
    const entry: MemoryIndexEntry = {
      title: "Valid",
      filePath: "test.md",
      hook: "",
    };
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });

  test("rejects whitespace-only hook after sanitization", () => {
    const entry: MemoryIndexEntry = {
      title: "Valid",
      filePath: "test.md",
      hook: "   ",
    };
    expect(formatMemoryIndexEntry(entry)).toBeUndefined();
  });
});

describe("parseMemoryIndexEntry (path validation)", () => {
  test("rejects parsed line with path traversal", () => {
    const line = "- [Evil](../../secret.md) — steal data";
    expect(parseMemoryIndexEntry(line)).toBeUndefined();
  });

  test("rejects parsed line with absolute path", () => {
    // Manually crafted — bypasses formatMemoryIndexEntry validation
    const line = "- [Evil](/etc/passwd.md) — steal data";
    expect(parseMemoryIndexEntry(line)).toBeUndefined();
  });

  test("rejects parsed line with percent-encoded traversal", () => {
    const line = "- [Evil](%2e%2e/secret.md) — steal data";
    expect(parseMemoryIndexEntry(line)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adversarial: control chars in parsed index entries
// ---------------------------------------------------------------------------

describe("parseMemoryIndexEntry (control char sanitization)", () => {
  test("strips control characters from parsed title", () => {
    // Manually crafted line with ESC sequence in title
    const esc = String.fromCharCode(0x1b);
    const line = `- [Te${esc}[31mst](test.md) \u2014 a hook`;
    const parsed = parseMemoryIndexEntry(line);
    if (parsed) {
      expect(hasFrontmatterUnsafeChars(parsed.title)).toBe(false);
    }
  });

  test("strips control characters from parsed hook", () => {
    const esc = String.fromCharCode(0x1b);
    const line = `- [Test](test.md) \u2014 hook${esc}[0m with escape`;
    const parsed = parseMemoryIndexEntry(line);
    if (parsed) {
      expect(hasFrontmatterUnsafeChars(parsed.hook)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: validator/serializer alignment
// ---------------------------------------------------------------------------

describe("validateMemoryRecordInput (post-sanitization alignment)", () => {
  test("rejects name made of only control characters", () => {
    const errors = validateMemoryRecordInput({
      name: "\x00\x01\x02",
      description: "valid",
      type: "user",
      content: "content",
    });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  test("rejects description made of only control characters", () => {
    const errors = validateMemoryRecordInput({
      name: "valid",
      description: "\x07\x08",
      type: "user",
      content: "content",
    });
    expect(errors.some((e) => e.field === "description")).toBe(true);
  });

  test("accepts name with mixed valid and control chars", () => {
    const errors = validateMemoryRecordInput({
      name: "valid\x00name",
      description: "desc",
      type: "user",
      content: "content",
    });
    // After sanitization "valid\x00name" → "validname" which is non-empty
    expect(errors.some((e) => e.field === "name")).toBe(false);
  });
});

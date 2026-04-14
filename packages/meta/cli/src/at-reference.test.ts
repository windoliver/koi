/**
 * Tests for @-reference parsing and content injection.
 */

import { describe, expect, test } from "bun:test";
import {
  formatAtReferencesForModel,
  parseAtReferences,
  resolveAtReferences,
} from "./at-reference.js";

// ---------------------------------------------------------------------------
// parseAtReferences
// ---------------------------------------------------------------------------

describe("parseAtReferences", () => {
  test("parses basic @path", () => {
    const refs = parseAtReferences("@src/math.ts explain this");
    expect(refs).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.filePath).toBe("src/math.ts");
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.lineStart).toBeUndefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.lineEnd).toBeUndefined();
  });

  test("parses @path with single line #L10", () => {
    const refs = parseAtReferences("@src/math.ts#L10 what is this line");
    expect(refs).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.filePath).toBe("src/math.ts");
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.lineStart).toBe(10);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.lineEnd).toBe(10);
  });

  test("parses @path with line range #L10-20", () => {
    const refs = parseAtReferences("@src/math.ts#L10-20 explain");
    expect(refs).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.filePath).toBe("src/math.ts");
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.lineStart).toBe(10);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.lineEnd).toBe(20);
  });

  test('parses quoted @"path with spaces"', () => {
    const refs = parseAtReferences('@"my file.ts" explain');
    expect(refs).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.filePath).toBe("my file.ts");
  });

  test("parses multiple @references", () => {
    const refs = parseAtReferences("@src/a.ts @src/b.ts compare these");
    expect(refs).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.filePath).toBe("src/a.ts");
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[1]!.filePath).toBe("src/b.ts");
  });

  test("returns empty for no @references", () => {
    const refs = parseAtReferences("just a regular message");
    expect(refs).toHaveLength(0);
  });

  test("ignores email-like @ in mid-word", () => {
    const refs = parseAtReferences("send to user@example.com");
    // The unquoted regex requires whitespace before @, so mid-word @ is skipped
    expect(refs).toHaveLength(0);
  });

  test("parses @path preceded by newline", () => {
    const refs = parseAtReferences("look at this:\n@src/math.ts");
    expect(refs).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.filePath).toBe("src/math.ts");
  });

  test("parses @path at start of string", () => {
    const refs = parseAtReferences("@package.json");
    expect(refs).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(refs[0]!.filePath).toBe("package.json");
  });
});

// ---------------------------------------------------------------------------
// resolveAtReferences
// ---------------------------------------------------------------------------

describe("resolveAtReferences", () => {
  // Use the actual monorepo root for real file reads
  const cwd = process.cwd();

  test("returns original text when no @refs", () => {
    const result = resolveAtReferences("hello world", cwd);
    expect(result.cleanText).toBe("hello world");
    expect(result.injections).toHaveLength(0);
  });

  test("resolves existing file and strips @ref from text", () => {
    const result = resolveAtReferences("@package.json what are the deps", cwd);
    expect(result.cleanText).toBe("what are the deps");
    expect(result.injections).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(result.injections[0]!.filePath).toBe("package.json");
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(result.injections[0]!.content.length).toBeGreaterThan(0);
  });

  test("silently skips non-existent files", () => {
    const result = resolveAtReferences("@nonexistent_file_xyz.ts explain", cwd);
    expect(result.cleanText).toBe("explain");
    expect(result.injections).toHaveLength(0);
  });

  test("resolves line range from real file", () => {
    const result = resolveAtReferences("@package.json#L1-3 explain", cwd);
    expect(result.cleanText).toBe("explain");
    expect(result.injections).toHaveLength(1);
    // Should contain only first 3 lines
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    const lines = result.injections[0]!.content.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  test("resolves multiple files", () => {
    // Both files exist relative to CLI package dir
    const result = resolveAtReferences("@package.json @tsconfig.json compare", cwd);
    expect(result.cleanText).toBe("compare");
    expect(result.injections).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatAtReferencesForModel
// ---------------------------------------------------------------------------

describe("formatAtReferencesForModel", () => {
  test("returns clean text when no injections", () => {
    const result = formatAtReferencesForModel({ cleanText: "hello", injections: [] });
    expect(result).toBe("hello");
  });

  test("formats file injection with XML tags", () => {
    const result = formatAtReferencesForModel({
      cleanText: "explain this",
      injections: [
        {
          filePath: "src/math.ts",
          content: "export const add = (a, b) => a + b;",
          lineStart: undefined,
          lineEnd: undefined,
          truncated: false,
        },
      ],
    });
    expect(result).toContain('<file path="src/math.ts">');
    expect(result).toContain("export const add");
    expect(result).toContain("</file>");
    expect(result).toContain("explain this");
  });

  test("includes line range in file tag", () => {
    const result = formatAtReferencesForModel({
      cleanText: "explain",
      injections: [
        {
          filePath: "src/math.ts",
          content: "line 10 content",
          lineStart: 10,
          lineEnd: 20,
          truncated: false,
        },
      ],
    });
    expect(result).toContain("(lines 10-20)");
  });

  test("includes truncation note when truncated", () => {
    const result = formatAtReferencesForModel({
      cleanText: "explain",
      injections: [
        {
          filePath: "big-file.ts",
          content: "partial content...",
          lineStart: undefined,
          lineEnd: undefined,
          truncated: true,
        },
      ],
    });
    expect(result).toContain("[Note: file was truncated due to size]");
  });

  test("question appears after file context", () => {
    const result = formatAtReferencesForModel({
      cleanText: "what does this do",
      injections: [
        {
          filePath: "a.ts",
          content: "code",
          lineStart: undefined,
          lineEnd: undefined,
          truncated: false,
        },
      ],
    });
    const fileIdx = result.indexOf("</file>");
    const questionIdx = result.indexOf("what does this do");
    expect(questionIdx).toBeGreaterThan(fileIdx);
  });
});

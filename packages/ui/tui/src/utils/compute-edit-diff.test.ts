import { describe, expect, test } from "bun:test";
import { computeEditDiff } from "./compute-edit-diff.js";

// ---------------------------------------------------------------------------
// computeEditDiff
// ---------------------------------------------------------------------------

describe("computeEditDiff", () => {
  test("simple replacement (old -> new)", () => {
    const result = computeEditDiff("hello\n", "world\n");
    expect(result).toContain("--- a/file");
    expect(result).toContain("+++ b/file");
    expect(result).toContain("@@ -1,1 +1,1 @@");
    expect(result).toContain("-hello");
    expect(result).toContain("+world");
  });

  test("addition only (empty old, non-empty new)", () => {
    const result = computeEditDiff("", "new line\n");
    expect(result).toContain("@@ -0,0 +1,1 @@");
    expect(result).toContain("+new line");
    // The "---" header line should exist but no removal content lines
    const lines = result.split("\n");
    const contentLines = lines.slice(3); // skip header + hunk header
    for (const line of contentLines) {
      expect(line.startsWith("+")).toBe(true);
    }
  });

  test("deletion only (non-empty old, empty new)", () => {
    const result = computeEditDiff("old line\n", "");
    expect(result).toContain("@@ -1,1 +0,0 @@");
    expect(result).toContain("-old line");
    const lines = result.split("\n");
    const contentLines = lines.slice(3);
    for (const line of contentLines) {
      expect(line.startsWith("-")).toBe(true);
    }
  });

  test("both empty returns empty string", () => {
    expect(computeEditDiff("", "")).toBe("");
  });

  test("multi-line old and new", () => {
    const oldStr = "line1\nline2\nline3\n";
    const newStr = "alpha\nbeta\n";
    const result = computeEditDiff(oldStr, newStr);
    expect(result).toContain("@@ -1,3 +1,2 @@");
    expect(result).toContain("-line1");
    expect(result).toContain("-line2");
    expect(result).toContain("-line3");
    expect(result).toContain("+alpha");
    expect(result).toContain("+beta");
  });

  test("custom filename in header", () => {
    const result = computeEditDiff("a\n", "b\n", "src/index.ts");
    expect(result).toContain("--- a/src/index.ts");
    expect(result).toContain("+++ b/src/index.ts");
  });

  test("default filename when not provided", () => {
    const result = computeEditDiff("a\n", "b\n");
    expect(result).toContain("--- a/file");
    expect(result).toContain("+++ b/file");
  });

  test("single line changes without trailing newline", () => {
    const result = computeEditDiff("old", "new");
    expect(result).toContain("@@ -1,1 +1,1 @@");
    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });

  test("lines with special characters", () => {
    const oldStr = "const x = { key: 'value' };\n";
    const newStr = 'const x = { key: "value", count: 42 };\n';
    const result = computeEditDiff(oldStr, newStr, "app.ts");
    expect(result).toContain("-const x = { key: 'value' };");
    expect(result).toContain('+const x = { key: "value", count: 42 };');
  });

  test("multi-line addition from empty", () => {
    const result = computeEditDiff("", "line1\nline2\nline3\n");
    expect(result).toContain("@@ -0,0 +1,3 @@");
    expect(result).toContain("+line1");
    expect(result).toContain("+line2");
    expect(result).toContain("+line3");
  });

  test("multi-line deletion to empty", () => {
    const result = computeEditDiff("line1\nline2\n", "");
    expect(result).toContain("@@ -1,2 +0,0 @@");
    expect(result).toContain("-line1");
    expect(result).toContain("-line2");
  });
});

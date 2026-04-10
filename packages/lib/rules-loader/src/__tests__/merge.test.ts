import { describe, expect, test } from "bun:test";

import type { LoadedFile } from "../config.js";
import { mergeRulesets } from "../merge.js";

function makeFile(overrides: Partial<LoadedFile> & { readonly content: string }): LoadedFile {
  return {
    path: "/test/CLAUDE.md",
    depth: 0,
    estimatedTokens: Math.ceil(overrides.content.length / 4),
    mtimeMs: Date.now(),
    ...overrides,
  };
}

describe("mergeRulesets", () => {
  test("returns empty result for no files", () => {
    const result = mergeRulesets([], 8000);
    expect(result.content).toBe("");
    expect(result.files).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test("wraps single file in project-rules tags", () => {
    const file = makeFile({ content: "# Rules", path: "/repo/CLAUDE.md" });
    const result = mergeRulesets([file], 8000);

    expect(result.content).toContain("<project-rules>");
    expect(result.content).toContain("</project-rules>");
    expect(result.content).toContain("# Rules");
    expect(result.content).toContain("<!-- source: /repo/CLAUDE.md (depth: 0) -->");
    expect(result.files).toEqual(["/repo/CLAUDE.md"]);
    expect(result.truncated).toBe(false);
  });

  test("merges multiple files root-first with separators", () => {
    const root = makeFile({ content: "root rules", path: "/repo/CLAUDE.md", depth: 0 });
    const child = makeFile({ content: "child rules", path: "/repo/src/CLAUDE.md", depth: 1 });

    const result = mergeRulesets([root, child], 8000);

    expect(result.content).toContain("root rules");
    expect(result.content).toContain("child rules");
    expect(result.content).toContain("---");
    expect(result.files).toEqual(["/repo/CLAUDE.md", "/repo/src/CLAUDE.md"]);
    expect(result.truncated).toBe(false);

    // Root appears before child
    const rootIdx = result.content.indexOf("root rules");
    const childIdx = result.content.indexOf("child rules");
    expect(rootIdx).toBeLessThan(childIdx);
  });

  test("truncates child files when budget exceeded", () => {
    const root = makeFile({ content: "a".repeat(100), path: "/repo/CLAUDE.md", depth: 0 });
    const child = makeFile({ content: "b".repeat(100), path: "/repo/src/CLAUDE.md", depth: 1 });

    // Set budget tight enough for root but not both
    const result = mergeRulesets([root, child], 50);

    expect(result.files).toEqual(["/repo/CLAUDE.md"]);
    expect(result.content).toContain("a".repeat(100));
    expect(result.content).not.toContain("b".repeat(100));
    expect(result.truncated).toBe(true);
  });

  test("truncates root file content when even root exceeds budget", () => {
    const root = makeFile({
      content: "x".repeat(1000),
      path: "/repo/CLAUDE.md",
      depth: 0,
    });

    // Budget enough for wrapper + some content, but not all 1000 chars
    const result = mergeRulesets([root], 100);

    expect(result.truncated).toBe(true);
    expect(result.files).toEqual(["/repo/CLAUDE.md"]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(100);
    // Content should be shorter than original
    expect(result.content.length).toBeLessThan(1000);
  });

  test("includes source markers with depth", () => {
    const file = makeFile({
      content: "rules",
      path: "/repo/src/deep/CLAUDE.md",
      depth: 3,
    });

    const result = mergeRulesets([file], 8000);
    expect(result.content).toContain("<!-- source: /repo/src/deep/CLAUDE.md (depth: 3) -->");
  });

  test("estimates tokens for merged content", () => {
    const file = makeFile({ content: "some rules content here", path: "/repo/CLAUDE.md" });
    const result = mergeRulesets([file], 8000);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test("truncated root file respects token budget (long path regression)", () => {
    // Long path increases overhead — naive char-slice could exceed budget
    const longPath = `/repo/${"deeply/nested/".repeat(10)}CLAUDE.md`;
    const root = makeFile({
      content: "x".repeat(2000),
      path: longPath,
      depth: 0,
    });

    // Budget large enough for wrapper overhead but not full content
    const budget = 200;
    const result = mergeRulesets([root], budget);

    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test("returns empty when budget cannot fit even wrapper overhead", () => {
    const longPath = `/repo/${"deeply/nested/".repeat(20)}CLAUDE.md`;
    const root = makeFile({ content: "x".repeat(100), path: longPath, depth: 0 });

    // Impossibly small budget
    const result = mergeRulesets([root], 5);

    expect(result.truncated).toBe(true);
    expect(result.content).toBe("");
    expect(result.files).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
  });
});

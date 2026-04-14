/**
 * Tests for file completion service — handler behavior, caching, top-level listing.
 * Scoring tests live in file-index.test.ts.
 */

import { describe, expect, mock, test } from "bun:test";
import { createFileCompletionHandler, resolveFileCompletionsFromList } from "./file-completions.js";

// ---------------------------------------------------------------------------
// resolveFileCompletionsFromList (convenience wrapper for tests)
// ---------------------------------------------------------------------------

describe("resolveFileCompletionsFromList", () => {
  const FILES: readonly string[] = [
    "src/math.ts",
    "src/main.ts",
    "src/components/App.tsx",
    "src/components/Button.tsx",
    "README.md",
    "package.json",
    "tsconfig.json",
  ];

  test("empty query returns first MAX_RESULTS files", () => {
    const results = resolveFileCompletionsFromList("", FILES);
    expect(results).toEqual(FILES);
  });

  test("matches files by fuzzy subsequence", () => {
    const results = resolveFileCompletionsFromList("src/m", FILES);
    expect(results.length).toBeGreaterThan(0);
    expect(results).toContain("src/math.ts");
    expect(results).toContain("src/main.ts");
  });

  test("ranks exact prefix matches higher", () => {
    const results = resolveFileCompletionsFromList("src/math", FILES);
    expect(results[0]).toBe("src/math.ts");
  });

  test("returns empty for no matches", () => {
    const results = resolveFileCompletionsFromList("zzz_nonexistent", FILES);
    expect(results).toEqual([]);
  });

  test("caps results at 15", () => {
    const manyFiles = Array.from({ length: 50 }, (_, i) => `file-${String(i).padStart(3, "0")}.ts`);
    const results = resolveFileCompletionsFromList("file", manyFiles);
    expect(results.length).toBeLessThanOrEqual(15);
  });

  test("case-insensitive matching", () => {
    const results = resolveFileCompletionsFromList("readme", FILES);
    expect(results).toContain("README.md");
  });

  test("includes directory entries in matching", () => {
    const filesWithDirs = ["src/", "src/utils/", "src/math.ts", "lib/index.ts"];
    const results = resolveFileCompletionsFromList("src", filesWithDirs);
    expect(results).toContain("src/");
  });
});

// ---------------------------------------------------------------------------
// createFileCompletionHandler (stateful handler with cache)
// ---------------------------------------------------------------------------

describe("createFileCompletionHandler", () => {
  test("dispatches empty results for null query (overlay dismissed)", () => {
    const dispatch = mock<(results: readonly string[]) => void>();
    const handler = createFileCompletionHandler("/tmp/test-cwd", dispatch);

    handler(null);

    expect(dispatch).toHaveBeenCalledWith([]);
  });

  test("empty query dispatches top-level paths immediately", () => {
    const dispatch = mock<(results: readonly string[]) => void>();
    const handler = createFileCompletionHandler(process.cwd(), dispatch);

    handler("");

    // Should dispatch synchronously (no debounce for empty query)
    expect(dispatch).toHaveBeenCalledTimes(1);
    const results = dispatch.mock.calls[0]?.[0];
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });

  test("dispatches results after debounce for cold cache", async () => {
    const dispatch = mock<(results: readonly string[]) => void>();
    const handler = createFileCompletionHandler("/tmp/test-cwd", dispatch);

    handler("test");

    // Results come after debounce (50ms) + async git ls-files
    await Bun.sleep(200);

    expect(dispatch).toHaveBeenCalled();
  });

  test("null query clears pending debounce timer", () => {
    const dispatch = mock<(results: readonly string[]) => void>();
    const handler = createFileCompletionHandler("/tmp/test-cwd", dispatch);

    // Fire a query (starts debounce)
    handler("test");
    // Immediately dismiss
    handler(null);

    // Should have been called once (the null dispatch)
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith([]);
  });
});

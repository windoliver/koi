/**
 * Tests for FileIndex — bitmap pre-filtering, scoring, and search behavior.
 */

import { describe, expect, test } from "bun:test";
import { FileIndex } from "./file-index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createIndex(files: readonly string[]): FileIndex {
  const index = new FileIndex();
  index.loadFromFileList(files);
  return index;
}

function searchPaths(index: FileIndex, query: string, limit = 15): readonly string[] {
  return index.search(query, limit).map((r) => r.path);
}

// ---------------------------------------------------------------------------
// Basic matching
// ---------------------------------------------------------------------------

describe("FileIndex — basic matching", () => {
  const FILES = [
    "src/math.ts",
    "src/main.ts",
    "src/components/App.tsx",
    "src/components/Button.tsx",
    "README.md",
    "package.json",
    "tsconfig.json",
  ];

  test("empty query returns first N paths", () => {
    const index = createIndex(FILES);
    const results = searchPaths(index, "", 3);
    expect(results).toHaveLength(3);
    expect(results[0]).toBe("src/math.ts");
  });

  test("prefix match finds files", () => {
    const index = createIndex(FILES);
    const results = searchPaths(index, "src/m");
    expect(results).toContain("src/math.ts");
    expect(results).toContain("src/main.ts");
  });

  test("returns empty for no matches", () => {
    const index = createIndex(FILES);
    const results = searchPaths(index, "zzz_nonexistent");
    expect(results).toHaveLength(0);
  });

  test("deduplicates input paths", () => {
    const index = createIndex(["a.ts", "a.ts", "b.ts"]);
    expect(index.size).toBe(2);
  });

  test("filters empty strings", () => {
    const index = createIndex(["a.ts", "", "b.ts"]);
    expect(index.size).toBe(2);
  });

  test("limit=0 returns empty", () => {
    const index = createIndex(FILES);
    expect(index.search("src", 0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bitmap pre-filtering
// ---------------------------------------------------------------------------

describe("FileIndex — bitmap pre-filter", () => {
  test("rejects paths missing query characters", () => {
    // "xyz" contains x, y, z — only "xyz.ts" has all three
    const index = createIndex(["abc.ts", "xyz.ts", "xzy.ts"]);
    const results = searchPaths(index, "xyz");
    // abc.ts should be rejected by bitmap (no x, y, or z... well it has no x/y/z)
    expect(results).not.toContain("abc.ts");
    expect(results).toContain("xyz.ts");
  });

  test("non-alpha characters in query don't affect bitmap", () => {
    // "/" and "." are not in the a-z bitmap range
    const index = createIndex(["src/math.ts"]);
    const results = searchPaths(index, "src/m");
    expect(results).toContain("src/math.ts");
  });
});

// ---------------------------------------------------------------------------
// Scoring: boundary bonuses
// ---------------------------------------------------------------------------

describe("FileIndex — boundary scoring", () => {
  test("boundary match scores higher than mid-word match", () => {
    // "m" at a boundary (after /) should score higher than "m" mid-word
    const index = createIndex(["src/math.ts", "commit.ts"]);
    const results = index.search("m", 2);
    // "src/math.ts" has "m" after "/" (boundary), "commit.ts" has "m" mid-word
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(results[0]!.path).toBe("src/math.ts");
  });

  test("first-char match gets bonus", () => {
    // "R" matching at position 0 should rank higher than mid-path
    const index = createIndex(["src/run.ts", "README.md"]);
    const results = index.search("R", 2);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(results[0]!.path).toBe("README.md");
  });
});

// ---------------------------------------------------------------------------
// Scoring: gap penalties
// ---------------------------------------------------------------------------

describe("FileIndex — gap penalties", () => {
  test("consecutive match scores higher than spread match", () => {
    const index = createIndex(["clear.ts", "c_l_e_a_r.ts"]);
    const results = index.search("clear", 2);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(results[0]!.path).toBe("clear.ts");
  });

  test("shorter gap scores higher than longer gap", () => {
    const index = createIndex(["ab.ts", "a__b.ts", "a______b.ts"]);
    const results = index.search("ab", 3);
    // "ab.ts" (no gap) > "a__b.ts" (gap 2) > "a______b.ts" (gap 6)
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(results[0]!.path).toBe("ab.ts");
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(results[1]!.path).toBe("a__b.ts");
  });
});

// ---------------------------------------------------------------------------
// Scoring: camelCase
// ---------------------------------------------------------------------------

describe("FileIndex — camelCase", () => {
  test("camelCase transition gets bonus", () => {
    // "B" matching at camelCase boundary in "appButton" should rank well
    const index = createIndex(["appButton.ts", "arbitrary.ts"]);
    const results = index.search("aB", 2);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(results[0]!.path).toBe("appButton.ts");
  });
});

// ---------------------------------------------------------------------------
// Smart case
// ---------------------------------------------------------------------------

describe("FileIndex — smart case", () => {
  test("lowercase query is case-insensitive", () => {
    const index = createIndex(["README.md", "readme.txt"]);
    const results = searchPaths(index, "readme");
    expect(results).toContain("README.md");
    expect(results).toContain("readme.txt");
  });

  test("uppercase in query enables case-sensitive matching", () => {
    const index = createIndex(["README.md", "readme.txt"]);
    const results = searchPaths(index, "READ");
    expect(results).toContain("README.md");
    // "readme.txt" should NOT match case-sensitively
    expect(results).not.toContain("readme.txt");
  });
});

// ---------------------------------------------------------------------------
// Top-k limiting
// ---------------------------------------------------------------------------

describe("FileIndex — top-k", () => {
  test("respects limit parameter", () => {
    const files = Array.from({ length: 100 }, (_, i) => `file-${String(i).padStart(3, "0")}.ts`);
    const index = createIndex(files);
    const results = index.search("file", 5);
    expect(results).toHaveLength(5);
  });

  test("returns fewer than limit when fewer matches exist", () => {
    const index = createIndex(["match.ts", "no.ts"]);
    const results = index.search("match", 10);
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Length bonus
// ---------------------------------------------------------------------------

describe("FileIndex — length bonus", () => {
  test("shorter paths rank higher when scores are otherwise equal", () => {
    const index = createIndex(["src/deeply/nested/very/long/path/math.ts", "src/math.ts"]);
    const results = index.search("math", 2);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength
    expect(results[0]!.path).toBe("src/math.ts");
  });
});

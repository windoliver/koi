/**
 * Tests for levenshteinDistance with maxDistance optimization.
 */

import { describe, expect, test } from "bun:test";
import { findClosestMatch, levenshteinDistance } from "./levenshtein.js";

// ---------------------------------------------------------------------------
// Basic correctness (backward-compatible — no maxDistance argument)
// ---------------------------------------------------------------------------

describe("levenshteinDistance", () => {
  test("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
    expect(levenshteinDistance("model", "model")).toBe(0);
  });

  test("returns length of other string when one is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("xyz", "")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  test("returns 0 for two empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  test("returns 1 for single character difference", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1); // substitution
    expect(levenshteinDistance("cat", "car")).toBe(1); // substitution
    expect(levenshteinDistance("cat", "cats")).toBe(1); // insertion
    expect(levenshteinDistance("tols", "tools")).toBe(1); // insertion
    expect(levenshteinDistance("scedule", "schedule")).toBe(1); // insertion
  });

  test("returns 2 for a transposition", () => {
    expect(levenshteinDistance("modle", "model")).toBe(2);
  });

  test("handles complex differences", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("anthropic", "anthrpic")).toBe(1);
  });

  test("is symmetric", () => {
    expect(levenshteinDistance("abc", "xyz")).toBe(levenshteinDistance("xyz", "abc"));
    expect(levenshteinDistance("kitten", "sitting")).toBe(levenshteinDistance("sitting", "kitten"));
  });
});

// ---------------------------------------------------------------------------
// maxDistance early-exit optimization
// ---------------------------------------------------------------------------

describe("levenshteinDistance with maxDistance", () => {
  test("returns exact distance when within maxDistance", () => {
    expect(levenshteinDistance("cat", "bat", 2)).toBe(1);
    expect(levenshteinDistance("kitten", "sitting", 3)).toBe(3);
    expect(levenshteinDistance("kitten", "sitting", 5)).toBe(3);
  });

  test("returns maxDistance + 1 when distance exceeds maxDistance", () => {
    // "kitten" -> "sitting" = 3, with maxDistance = 2 should return 3
    expect(levenshteinDistance("kitten", "sitting", 2)).toBe(3);
    // "abc" -> "xyz" = 3, with maxDistance = 1 should return 2
    expect(levenshteinDistance("abc", "xyz", 1)).toBe(2);
  });

  test("early-exits on large length difference", () => {
    // "a" vs "abcdef" = distance 5, maxDistance = 2 -> immediate return 3
    expect(levenshteinDistance("a", "abcdef", 2)).toBe(3);
    // "ab" vs "abcdefgh" = distance 6, maxDistance = 3 -> immediate return 4
    expect(levenshteinDistance("ab", "abcdefgh", 3)).toBe(4);
  });

  test("returns 0 for identical strings regardless of maxDistance", () => {
    expect(levenshteinDistance("hello", "hello", 0)).toBe(0);
    expect(levenshteinDistance("hello", "hello", 1)).toBe(0);
  });

  test("maxDistance = 0 only matches identical strings", () => {
    expect(levenshteinDistance("abc", "abc", 0)).toBe(0);
    expect(levenshteinDistance("abc", "abd", 0)).toBe(1);
  });

  test("maxDistance = Infinity behaves like no maxDistance", () => {
    expect(levenshteinDistance("kitten", "sitting", Infinity)).toBe(3);
    expect(levenshteinDistance("abc", "xyz", Infinity)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// findClosestMatch — higher-level helper
// ---------------------------------------------------------------------------

describe("findClosestMatch", () => {
  test("returns undefined for empty candidates", () => {
    expect(findClosestMatch("hello", [])).toBeUndefined();
  });

  test("returns exact match", () => {
    expect(findClosestMatch("model", ["model", "engine", "channel"])).toBe("model");
  });

  test("returns close match within default threshold", () => {
    expect(findClosestMatch("modle", ["model", "engine", "channel"])).toBe("model");
  });

  test("returns undefined when no match within threshold", () => {
    expect(findClosestMatch("zzzzz", ["model", "engine", "channel"])).toBeUndefined();
  });

  test("picks closest among multiple candidates", () => {
    expect(findClosestMatch("cat", ["bat", "car", "dog"])).toBe("bat");
  });

  test("respects custom maxDistance parameter", () => {
    // "cat" -> "bat" = 1, within maxDistance=1
    expect(findClosestMatch("cat", ["bat", "dog"], 1)).toBe("bat");
    // "cat" -> "dog" = 3, exceeds maxDistance=1
    expect(findClosestMatch("cat", ["dog"], 1)).toBeUndefined();
  });

  test("returns first match when distances are tied", () => {
    // "bat" -> "cat" = 1, "bat" -> "hat" = 1, first wins (reduce keeps first)
    const result = findClosestMatch("bat", ["cat", "hat"]);
    expect(result).toBe("cat");
  });
});

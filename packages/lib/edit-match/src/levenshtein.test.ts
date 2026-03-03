import { describe, expect, test } from "bun:test";
import { computeLevenshtein, computeSlidingWindowMatch, FUZZY_THRESHOLD } from "./levenshtein.js";

describe("computeLevenshtein", () => {
  test("returns 0 for identical strings", () => {
    expect(computeLevenshtein("hello", "hello", 10)).toBe(0);
  });

  test("returns string length for empty vs non-empty", () => {
    expect(computeLevenshtein("", "hello", 10)).toBe(5);
    expect(computeLevenshtein("hello", "", 10)).toBe(5);
  });

  test("returns correct edit distance", () => {
    expect(computeLevenshtein("kitten", "sitting", 10)).toBe(3);
    expect(computeLevenshtein("saturday", "sunday", 10)).toBe(3);
  });

  test("returns early when length difference exceeds maxDistance", () => {
    const result = computeLevenshtein("ab", "abcdefgh", 2);
    expect(result).toBeGreaterThan(2);
  });

  test("returns early when rowMin exceeds maxDistance", () => {
    const result = computeLevenshtein("aaaa", "zzzz", 1);
    expect(result).toBeGreaterThan(1);
  });
});

describe("computeSlidingWindowMatch", () => {
  test("finds exact match within source", () => {
    const source = "line1\nline2\nline3\nline4";
    const search = "line2\nline3";
    const result = computeSlidingWindowMatch(source, search, FUZZY_THRESHOLD);
    expect(result).toBeDefined();
    expect(result?.similarity).toBe(1);
  });

  test("finds fuzzy match with minor differences", () => {
    const source = "function hello() {\n  return 'world';\n}";
    const search = "function hello() {\n  return 'worl';\n}";
    const result = computeSlidingWindowMatch(source, search, FUZZY_THRESHOLD);
    expect(result).toBeDefined();
    expect(result?.similarity).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });

  test("returns undefined when no match meets threshold", () => {
    const source = "completely different text";
    const search = "nothing in common here at all with any of it";
    const result = computeSlidingWindowMatch(source, search, FUZZY_THRESHOLD);
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty inputs", () => {
    expect(computeSlidingWindowMatch("", "test", FUZZY_THRESHOLD)).toBeUndefined();
    expect(computeSlidingWindowMatch("test", "", FUZZY_THRESHOLD)).toBeUndefined();
  });

  test("match indices are correct", () => {
    const source = "aaa\nbbb\nccc";
    const search = "bbb";
    const result = computeSlidingWindowMatch(source, search, FUZZY_THRESHOLD);
    expect(result).toBeDefined();
    expect(source.slice(result?.startIndex, result?.endIndex)).toBe("bbb");
  });
});

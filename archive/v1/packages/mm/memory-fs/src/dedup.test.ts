import { describe, expect, test } from "bun:test";
import { jaccard, tokenize } from "./dedup.js";

describe("tokenize", () => {
  test("splits Latin text by whitespace and lowercases", () => {
    const tokens = tokenize("Hello World");
    expect(tokens).toEqual(new Set(["hello", "world"]));
  });

  test("returns character bigrams for CJK text", () => {
    const tokens = tokenize("今日は");
    expect(tokens).toEqual(new Set(["今日", "日は"]));
  });

  test("returns empty set for empty string", () => {
    expect(tokenize("")).toEqual(new Set());
  });

  test("handles single word", () => {
    expect(tokenize("hello")).toEqual(new Set(["hello"]));
  });

  test("handles single CJK character", () => {
    const tokens = tokenize("日");
    expect(tokens).toEqual(new Set(["日"]));
  });

  test("collapses whitespace in CJK", () => {
    const tokens = tokenize("今日 は");
    expect(tokens).toEqual(new Set(["今日", "日は"]));
  });
});

describe("jaccard", () => {
  test("returns 1.0 for identical strings", () => {
    expect(jaccard("hello world", "hello world")).toBe(1);
  });

  test("returns 0.0 for completely different strings", () => {
    expect(jaccard("alpha beta", "gamma delta")).toBe(0);
  });

  test("returns 1.0 for two empty strings", () => {
    expect(jaccard("", "")).toBe(1);
  });

  test("returns 0.0 when one string is empty", () => {
    expect(jaccard("hello", "")).toBe(0);
    expect(jaccard("", "hello")).toBe(0);
  });

  test("computes partial overlap correctly", () => {
    // "the cat sat" vs "the cat ran" → intersection {"the", "cat"} = 2, union = 4
    const score = jaccard("the cat sat", "the cat ran");
    expect(score).toBeCloseTo(0.5, 5);
  });

  test("is case-insensitive", () => {
    expect(jaccard("Hello World", "hello world")).toBe(1);
  });

  test("handles dedup threshold boundary", () => {
    // 3 of 4 words match → 0.75
    const score = jaccard("a b c d", "a b c e");
    expect(score).toBeCloseTo(0.6, 5); // intersection=3, union=5 → 0.6
  });

  test("works with CJK text", () => {
    const score = jaccard("今日は天気", "今日は良い");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test("CJK identical strings return 1.0", () => {
    expect(jaccard("今日は", "今日は")).toBe(1);
  });
});

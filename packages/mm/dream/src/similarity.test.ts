import { describe, expect, test } from "bun:test";
import { jaccard } from "./similarity.js";

describe("jaccard", () => {
  test("returns 1.0 for identical strings", () => {
    expect(jaccard("hello world", "hello world")).toBe(1.0);
  });

  test("returns 1.0 for two empty strings", () => {
    expect(jaccard("", "")).toBe(1.0);
  });

  test("returns 0.0 for completely different strings", () => {
    expect(jaccard("apple banana", "cherry dragonfruit")).toBe(0.0);
  });

  test("returns 0.0 when one string is empty", () => {
    expect(jaccard("hello", "")).toBe(0.0);
    expect(jaccard("", "hello")).toBe(0.0);
  });

  test("computes correct similarity for partial overlap", () => {
    // {"hello", "world"} vs {"hello", "there"} => intersection=1, union=3 => 1/3
    const sim = jaccard("hello world", "hello there");
    expect(sim).toBeCloseTo(1 / 3, 5);
  });

  test("is case-insensitive", () => {
    expect(jaccard("Hello World", "hello world")).toBe(1.0);
  });

  test("ignores punctuation", () => {
    expect(jaccard("hello, world!", "hello world")).toBe(1.0);
  });

  test("handles unicode words", () => {
    const sim = jaccard("bonjour monde", "bonjour monde");
    expect(sim).toBe(1.0);
  });
});

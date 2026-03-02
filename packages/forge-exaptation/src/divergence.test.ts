import { describe, expect, it } from "bun:test";
import { computeJaccardDistance, tokenize, truncateToWords } from "./divergence.js";

describe("tokenize", () => {
  it("lowercases and splits on non-word characters", () => {
    const result = tokenize("Hello World! Foo-Bar");
    expect(result).toEqual(new Set(["hello", "world", "foo", "bar"]));
  });

  it("filters stopwords", () => {
    const result = tokenize("the quick brown fox and the lazy dog");
    expect(result.has("the")).toBe(false);
    expect(result.has("and")).toBe(false);
    expect(result).toEqual(new Set(["quick", "brown", "fox", "lazy", "dog"]));
  });

  it("filters tokens shorter than 3 characters", () => {
    const result = tokenize("I am so very ok at it");
    // "very" is the only token >= 3 chars and not a stopword
    expect(result).toEqual(new Set(["very"]));
  });

  it("returns empty set for empty string", () => {
    expect(tokenize("")).toEqual(new Set());
  });

  it("handles unicode text without crashing", () => {
    const result = tokenize("こんにちは world 你好 testing");
    // Should at least extract ASCII tokens
    expect(result.has("world")).toBe(true);
    expect(result.has("testing")).toBe(true);
  });

  it("deduplicates repeated words", () => {
    const result = tokenize("test test test value value");
    expect(result).toEqual(new Set(["test", "value"]));
  });
});

describe("computeJaccardDistance", () => {
  it("returns 0 for identical sets", () => {
    const a = new Set(["foo", "bar", "baz"]);
    const b = new Set(["foo", "bar", "baz"]);
    expect(computeJaccardDistance(a, b)).toBe(0);
  });

  it("returns 1 for completely disjoint sets", () => {
    const a = new Set(["foo", "bar"]);
    const b = new Set(["baz", "qux"]);
    expect(computeJaccardDistance(a, b)).toBe(1);
  });

  it("returns 0 for two empty sets", () => {
    expect(computeJaccardDistance(new Set(), new Set())).toBe(0);
  });

  it("returns 1 when one set is empty and the other is not", () => {
    const a = new Set(["foo"]);
    expect(computeJaccardDistance(a, new Set())).toBe(1);
    expect(computeJaccardDistance(new Set(), a)).toBe(1);
  });

  it("is symmetric: distance(a, b) === distance(b, a)", () => {
    const a = new Set(["foo", "bar", "shared"]);
    const b = new Set(["baz", "shared"]);
    expect(computeJaccardDistance(a, b)).toBe(computeJaccardDistance(b, a));
  });

  it("returns value between 0 and 1 for partial overlap", () => {
    const a = new Set(["foo", "bar", "shared"]);
    const b = new Set(["baz", "shared"]);
    const distance = computeJaccardDistance(a, b);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(1);
    // intersection = 1 (shared), union = 4 (foo, bar, shared, baz)
    // distance = 1 - 1/4 = 0.75
    expect(distance).toBeCloseTo(0.75);
  });

  it("bounds: 0 <= distance <= 1 for any input", () => {
    const cases = [
      [new Set(["a"]), new Set(["a"])],
      [new Set(["a"]), new Set(["b"])],
      [new Set(["a", "b"]), new Set(["b", "c"])],
      [new Set<string>(), new Set<string>()],
    ] as const;

    for (const [a, b] of cases) {
      const d = computeJaccardDistance(a, b);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });
});

describe("truncateToWords", () => {
  it("returns original text when under limit", () => {
    expect(truncateToWords("hello world", 10)).toBe("hello world");
  });

  it("truncates to max words", () => {
    expect(truncateToWords("one two three four five", 3)).toBe("one two three");
  });

  it("handles empty string", () => {
    expect(truncateToWords("", 5)).toBe("");
  });

  it("handles maxWords of 1", () => {
    expect(truncateToWords("hello world", 1)).toBe("hello");
  });

  it("handles text at exact word limit", () => {
    expect(truncateToWords("one two three", 3)).toBe("one two three");
  });
});

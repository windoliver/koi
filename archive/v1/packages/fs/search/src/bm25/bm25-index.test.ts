import { describe, expect, test } from "bun:test";
import { createBm25Index, defaultTokenize } from "./bm25-index.js";

describe("BM25Index", () => {
  test("empty corpus, any query → empty results", () => {
    const index = createBm25Index();
    expect(index.search(["hello"], 10)).toEqual([]);
  });

  test("empty query, non-empty corpus → empty results", () => {
    const index = createBm25Index().add("1", ["hello", "world"]);
    expect(index.search([], 10)).toEqual([]);
  });

  test("single document, matching query → score > 0", () => {
    const index = createBm25Index().add("1", ["hello", "world"]);
    const results = index.search(["hello"], 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("single document, non-matching query → empty results", () => {
    const index = createBm25Index().add("1", ["hello", "world"]);
    expect(index.search(["goodbye"], 10)).toEqual([]);
  });

  test("multiple docs, ranking order — higher TF → higher score", () => {
    let index = createBm25Index();
    index = index.add("low", ["cat", "dog"]);
    index = index.add("high", ["cat", "cat", "cat", "dog"]);
    const results = index.search(["cat"], 10);
    expect(results[0]?.id).toBe("high");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  test("duplicate documents — last add wins", () => {
    let index = createBm25Index();
    index = index.add("1", ["hello"]);
    index = index.add("1", ["world"]);
    expect(index.size).toBe(1);
    expect(index.search(["hello"], 10)).toEqual([]);
    expect(index.search(["world"], 10)).toHaveLength(1);
  });

  test("long doc vs short doc — length normalization (b param)", () => {
    let index = createBm25Index({ b: 0.75 });
    // Short doc has 1 "cat" in 2 tokens → higher density
    index = index.add("short", ["cat", "dog"]);
    // Long doc has 1 "cat" in 10 tokens → lower density
    index = index.add("long", ["cat", ...Array.from({ length: 9 }, () => "filler")]);
    const results = index.search(["cat"], 10);
    expect(results[0]?.id).toBe("short");
  });

  test("high-frequency term — k1 TF saturation", () => {
    let index = createBm25Index({ k1: 1.2 });
    index = index.add(
      "5x",
      Array.from({ length: 5 }, () => "cat"),
    );
    index = index.add(
      "50x",
      Array.from({ length: 50 }, () => "cat"),
    );
    const results = index.search(["cat"], 10);
    // Both match, but 50x has diminishing returns due to TF saturation
    expect(results).toHaveLength(2);
    // Score ratio should be much less than 10x
    const ratio = (results[0]?.score ?? 0) / (results[1]?.score ?? 1);
    expect(ratio).toBeLessThan(5);
  });

  test("unicode text — tokenization handles non-ASCII", () => {
    const tokens = defaultTokenize("こんにちは 世界 hello");
    let index = createBm25Index();
    index = index.add("1", tokens);
    const results = index.search(["こんにちは"], 10);
    expect(results).toHaveLength(1);
  });

  test("case insensitivity — defaultTokenize lowercases", () => {
    const tokens = defaultTokenize("Hello WORLD");
    expect(tokens).toEqual(["hello", "world"]);
    let index = createBm25Index();
    index = index.add("1", tokens);
    expect(index.search(["hello"], 10)).toHaveLength(1);
  });

  test("add then remove — index state is correct", () => {
    let index = createBm25Index();
    index = index.add("1", ["hello"]);
    index = index.add("2", ["world"]);
    expect(index.size).toBe(2);
    index = index.remove("1");
    expect(index.size).toBe(1);
    expect(index.search(["hello"], 10)).toEqual([]);
    expect(index.search(["world"], 10)).toHaveLength(1);
  });

  test("incremental add — IDF stats updated", () => {
    let index = createBm25Index();
    index = index.add("1", ["rare", "common"]);
    const before = index.search(["rare"], 10);

    // Add many docs with "common" but not "rare"
    for (let i = 2; i <= 10; i++) {
      index = index.add(String(i), ["common", "stuff"]);
    }

    const after = index.search(["rare"], 10);
    // "rare" should have higher IDF now (appears in fewer docs relative to corpus)
    expect(after[0]?.score).toBeGreaterThan(before[0]?.score ?? 0);
  });

  test("limit parameter is respected", () => {
    let index = createBm25Index();
    for (let i = 0; i < 10; i++) {
      index = index.add(String(i), ["match", `unique${i}`]);
    }
    const results = index.search(["match"], 3);
    expect(results).toHaveLength(3);
  });

  test("immutability — add returns new index, original unchanged", () => {
    const original = createBm25Index();
    const withDoc = original.add("1", ["hello"]);
    expect(original.size).toBe(0);
    expect(withDoc.size).toBe(1);
  });

  test("remove non-existent id — returns same size", () => {
    const index = createBm25Index().add("1", ["hello"]);
    const after = index.remove("999");
    expect(after.size).toBe(1);
  });
});

describe("defaultTokenize", () => {
  test("lowercases and splits on whitespace", () => {
    expect(defaultTokenize("Hello World")).toEqual(["hello", "world"]);
  });

  test("handles multiple whitespace types", () => {
    expect(defaultTokenize("a\tb\nc")).toEqual(["a", "b", "c"]);
  });

  test("filters empty tokens", () => {
    expect(defaultTokenize("  a  b  ")).toEqual(["a", "b"]);
  });

  test("returns empty for whitespace-only input", () => {
    expect(defaultTokenize("   ")).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import type { SearchResult } from "@koi/core";
import { applyMmr } from "./mmr.js";

function makeResult(id: string, score: number, content: string): SearchResult {
  return { id, score, content, metadata: {}, source: "test" };
}

describe("applyMmr", () => {
  test("empty input returns empty", () => {
    expect(applyMmr([], 5)).toEqual([]);
  });

  test("single result returns it unchanged", () => {
    const results = [makeResult("a", 0.9, "hello world")];
    const mmr = applyMmr(results, 5);
    expect(mmr).toHaveLength(1);
    expect(mmr[0]?.id).toBe("a");
  });

  test("respects limit", () => {
    const results = [
      makeResult("a", 0.9, "alpha beta gamma"),
      makeResult("b", 0.8, "delta epsilon zeta"),
      makeResult("c", 0.7, "eta theta iota"),
    ];
    const mmr = applyMmr(results, 2);
    expect(mmr).toHaveLength(2);
  });

  test("demotes near-duplicate content", () => {
    const results = [
      makeResult("a", 0.9, "TypeScript is a typed superset of JavaScript"),
      makeResult("b", 0.85, "TypeScript is a typed superset of JavaScript that compiles"),
      makeResult("c", 0.7, "Python is great for data science and machine learning"),
    ];

    // With high lambda (relevance-focused), b should follow a
    const relevanceFocused = applyMmr(results, 3, { lambda: 0.99 });
    expect(relevanceFocused[0]?.id).toBe("a");
    expect(relevanceFocused[1]?.id).toBe("b");

    // With low lambda (diversity-focused), c should come before b
    const diversityFocused = applyMmr(results, 3, { lambda: 0.3 });
    expect(diversityFocused[0]?.id).toBe("a");
    expect(diversityFocused[1]?.id).toBe("c"); // Diverse pick over near-duplicate
  });

  test("highest score is always first pick", () => {
    const results = [
      makeResult("low", 0.3, "completely different content"),
      makeResult("high", 0.95, "the best matching result"),
      makeResult("mid", 0.6, "somewhat relevant content"),
    ];
    const mmr = applyMmr(results, 3);
    expect(mmr[0]?.id).toBe("high");
  });

  test("lambda=1 degenerates to pure relevance ranking", () => {
    const results = [
      makeResult("a", 0.9, "same words same content"),
      makeResult("b", 0.8, "same words same content duplicate"),
      makeResult("c", 0.7, "same words same content copy"),
    ];
    const mmr = applyMmr(results, 3, { lambda: 1 });
    expect(mmr[0]?.id).toBe("a");
    expect(mmr[1]?.id).toBe("b");
    expect(mmr[2]?.id).toBe("c");
  });

  test("lambda=0 maximizes diversity", () => {
    const results = [
      makeResult("a", 0.9, "javascript typescript programming"),
      makeResult("b", 0.85, "javascript typescript coding"),
      makeResult("c", 0.5, "python machine learning data science"),
    ];
    const mmr = applyMmr(results, 3, { lambda: 0 });
    // First is still highest score, but second should be most diverse
    expect(mmr[0]?.id).toBe("a");
    expect(mmr[1]?.id).toBe("c"); // Most different from "a"
  });

  test("all identical content still returns all results", () => {
    const results = [
      makeResult("a", 0.9, "hello world"),
      makeResult("b", 0.8, "hello world"),
      makeResult("c", 0.7, "hello world"),
    ];
    const mmr = applyMmr(results, 3);
    expect(mmr).toHaveLength(3);
  });
});

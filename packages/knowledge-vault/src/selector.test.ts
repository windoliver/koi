import { describe, expect, test } from "bun:test";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { type ScoredDocument, selectWithinBudget } from "./selector.js";
import type { KnowledgeDocument, KnowledgeSourceInfo } from "./types.js";

function makeDoc(path: string, content: string, relevanceScore: number): KnowledgeDocument {
  return {
    path,
    title: path,
    content,
    tags: [],
    lastModified: Date.now(),
    relevanceScore,
  };
}

function makeScored(doc: KnowledgeDocument, sourceIndex: number): ScoredDocument {
  return { document: doc, sourceIndex };
}

const sources: readonly KnowledgeSourceInfo[] = [
  { name: "source-a", kind: "directory", documentCount: 3 },
  { name: "source-b", kind: "directory", documentCount: 2 },
];

describe("selectWithinBudget", () => {
  test("budget fits all docs - all selected", () => {
    const docs = [
      makeScored(makeDoc("a1", "short", 0.9), 0),
      makeScored(makeDoc("a2", "text", 0.8), 0),
      makeScored(makeDoc("b1", "word", 0.7), 1),
    ];

    const result = selectWithinBudget(docs, sources, 10000, HEURISTIC_ESTIMATOR);

    expect(result.selected).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });

  test("budget fits none - first doc still included", () => {
    const docs = [makeScored(makeDoc("a1", "x".repeat(400), 0.9), 0)];

    // Budget of 1 token can't fit 100-token doc, but we include it anyway
    const result = selectWithinBudget(docs, [sources[0]!], 1, HEURISTIC_ESTIMATOR);

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.path).toBe("a1");
  });

  test("budget = 0 returns empty results", () => {
    const docs = [makeScored(makeDoc("a1", "content", 0.9), 0)];

    const result = selectWithinBudget(docs, sources, 0, HEURISTIC_ESTIMATOR);

    expect(result.selected).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
  });

  test("diversity guarantee: each source gets at least 1 doc", () => {
    // Source A has high-scoring docs, source B has lower
    const docs = [
      makeScored(makeDoc("a1", "x".repeat(40), 0.95), 0),
      makeScored(makeDoc("a2", "x".repeat(40), 0.9), 0),
      makeScored(makeDoc("a3", "x".repeat(40), 0.85), 0),
      makeScored(makeDoc("b1", "x".repeat(40), 0.5), 1),
      makeScored(makeDoc("b2", "x".repeat(40), 0.45), 1),
    ];

    // Budget fits ~3 docs (each ~10 tokens at 4 chars/token)
    const result = selectWithinBudget(docs, sources, 30, HEURISTIC_ESTIMATOR);

    const selectedPaths = result.selected.map((d) => d.path);
    // Source B should be represented even though source A has higher scores
    expect(selectedPaths).toContain("b1");
    expect(selectedPaths).toContain("a1");
  });

  test("large source does not crowd out small source", () => {
    const docs = [
      makeScored(makeDoc("a1", "x".repeat(40), 0.95), 0),
      makeScored(makeDoc("a2", "x".repeat(40), 0.9), 0),
      makeScored(makeDoc("a3", "x".repeat(40), 0.85), 0),
      makeScored(makeDoc("a4", "x".repeat(40), 0.8), 0),
      makeScored(makeDoc("b1", "x".repeat(40), 0.5), 1),
    ];

    // Budget fits exactly 2 docs
    const result = selectWithinBudget(docs, sources, 20, HEURISTIC_ESTIMATOR);

    const selectedPaths = result.selected.map((d) => d.path);
    expect(selectedPaths).toContain("b1");
  });

  test("documents ordered by relevance in output", () => {
    const docs = [
      makeScored(makeDoc("low", "word", 0.3), 0),
      makeScored(makeDoc("high", "text", 0.9), 0),
      makeScored(makeDoc("mid", "data", 0.6), 1),
    ];

    const result = selectWithinBudget(docs, sources, 10000, HEURISTIC_ESTIMATOR);

    const scores = result.selected.map((d) => d.relevanceScore);
    for (const [i, score] of scores.entries()) {
      if (i > 0) {
        expect(score).toBeLessThanOrEqual(scores[i - 1]!);
      }
    }
  });

  test("single source uses pure greedy behavior", () => {
    const singleSource: readonly KnowledgeSourceInfo[] = [
      { name: "only", kind: "directory", documentCount: 3 },
    ];

    const docs = [
      makeScored(makeDoc("d1", "x".repeat(40), 0.9), 0),
      makeScored(makeDoc("d2", "x".repeat(40), 0.8), 0),
      makeScored(makeDoc("d3", "x".repeat(40), 0.7), 0),
    ];

    // Budget fits 2 docs
    const result = selectWithinBudget(docs, singleSource, 20, HEURISTIC_ESTIMATOR);

    expect(result.selected).toHaveLength(2);
    expect(result.selected[0]?.path).toBe("d1");
    expect(result.selected[1]?.path).toBe("d2");
  });

  test("exact budget boundary (doc tokens === remaining budget)", () => {
    // 20 chars = 5 tokens with heuristic (4 chars/token)
    const docs = [makeScored(makeDoc("exact", "x".repeat(20), 0.9), 0)];

    const result = selectWithinBudget(docs, [sources[0]!], 5, HEURISTIC_ESTIMATOR);

    expect(result.selected).toHaveLength(1);
    expect(result.totalTokens).toBe(5);
  });
});

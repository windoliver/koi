import { describe, expect, test } from "bun:test";
import { computeSalienceScore, computeSalienceScores, normalizeScores } from "./salience.js";
import type { MemoryFact, ScoredCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal MemoryFact for tests
// ---------------------------------------------------------------------------

function createTestFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "test-id",
    fact: "test fact",
    category: "context",
    timestamp: new Date().toISOString(),
    status: "active",
    supersededBy: null,
    relatedEntities: [],
    lastAccessed: new Date().toISOString(),
    accessCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeScores
// ---------------------------------------------------------------------------

describe("normalizeScores", () => {
  // With SIMILARITY_FLOOR=0.1, range is [0.1, 1.0]:
  // normalized = 0.1 + 0.9 * ((s - min) / (max - min))
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: readonly number[];
    readonly expected: readonly number[];
  }> = [
    { name: "empty input → empty output", input: [], expected: [] },
    { name: "single element → [1.0]", input: [5.0], expected: [1.0] },
    { name: "uniform scores → all 1.0", input: [3, 3, 3], expected: [1.0, 1.0, 1.0] },
    { name: "two extremes → [0.1, 1.0]", input: [0, 10], expected: [0.1, 1.0] },
    { name: "three values → linear spread", input: [2, 5, 8], expected: [0.1, 0.55, 1.0] },
    {
      name: "negative values normalize correctly",
      input: [-10, 0, 10],
      expected: [0.1, 0.55, 1.0],
    },
    {
      name: "close floating-point values",
      input: [0.001, 0.002],
      expected: [0.1, 1.0],
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      const result = normalizeScores(input);
      expect(result.length).toBe(expected.length);
      for (const [i, val] of result.entries()) {
        expect(val).toBeCloseTo(expected[i] ?? 0, 10);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// computeSalienceScore
// ---------------------------------------------------------------------------

describe("computeSalienceScore", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly similarity: number;
    readonly accessCount: number;
    readonly decayScore: number;
    readonly expected: number;
  }> = [
    {
      name: "new fact, perfect match, fresh → log(2) ≈ 0.693",
      similarity: 1.0,
      accessCount: 0,
      decayScore: 1.0,
      expected: Math.log(2),
    },
    {
      name: "zero similarity kills score regardless of access/decay",
      similarity: 0.0,
      accessCount: 100,
      decayScore: 1.0,
      expected: 0.0,
    },
    {
      name: "high reinforcement → log(12) ≈ 2.485",
      similarity: 1.0,
      accessCount: 10,
      decayScore: 1.0,
      expected: Math.log(12),
    },
    {
      name: "fully decayed → 0.0",
      similarity: 1.0,
      accessCount: 0,
      decayScore: 0.0,
      expected: 0.0,
    },
    {
      name: "all factors contribute",
      similarity: 0.5,
      accessCount: 4,
      decayScore: 0.8,
      expected: 0.5 * Math.log(6) * 0.8,
    },
    {
      name: "moderate access + moderate decay",
      similarity: 0.7,
      accessCount: 3,
      decayScore: 0.5,
      expected: 0.7 * Math.log(5) * 0.5,
    },
  ];

  for (const { name, similarity, accessCount, decayScore, expected } of cases) {
    test(name, () => {
      const result = computeSalienceScore(similarity, accessCount, decayScore);
      expect(result).toBeCloseTo(expected, 10);
    });
  }
});

// ---------------------------------------------------------------------------
// computeSalienceScores (batch)
// ---------------------------------------------------------------------------

describe("computeSalienceScores", () => {
  const now = new Date();
  const halfLifeDays = 30;

  test("empty input → empty output", () => {
    const result = computeSalienceScores([], now, { halfLifeDays });
    expect(result).toEqual([]);
  });

  test("single candidate normalizes similarity to 1.0", () => {
    const candidate: ScoredCandidate = {
      fact: createTestFact({ lastAccessed: now.toISOString(), accessCount: 0 }),
      entity: "test",
      score: 42.0,
    };

    const result = computeSalienceScores([candidate], now, { halfLifeDays });
    expect(result).toHaveLength(1);
    // similarity=1.0 (normalized single), accessCount=0 → log(2), decay≈1.0 (fresh)
    expect(result[0]?.score).toBeCloseTo(Math.log(2), 2);
  });

  test("higher similarity → higher salience (same access/age)", () => {
    const candidates: readonly ScoredCandidate[] = [
      {
        fact: createTestFact({ id: "low", lastAccessed: now.toISOString(), accessCount: 0 }),
        entity: "test",
        score: 1.0,
      },
      {
        fact: createTestFact({ id: "high", lastAccessed: now.toISOString(), accessCount: 0 }),
        entity: "test",
        score: 10.0,
      },
    ];

    const result = computeSalienceScores(candidates, now, { halfLifeDays });
    const lowScore = result.find((c) => c.fact.id === "low")?.score ?? 0;
    const highScore = result.find((c) => c.fact.id === "high")?.score ?? 0;
    expect(highScore).toBeGreaterThan(lowScore);
  });

  test("higher accessCount → higher salience (same similarity/age)", () => {
    const candidates: readonly ScoredCandidate[] = [
      {
        fact: createTestFact({ id: "new", lastAccessed: now.toISOString(), accessCount: 0 }),
        entity: "test",
        score: 5.0,
      },
      {
        fact: createTestFact({ id: "popular", lastAccessed: now.toISOString(), accessCount: 10 }),
        entity: "test",
        score: 5.0,
      },
    ];

    const result = computeSalienceScores(candidates, now, { halfLifeDays });
    const newScore = result.find((c) => c.fact.id === "new")?.score ?? 0;
    const popularScore = result.find((c) => c.fact.id === "popular")?.score ?? 0;
    expect(popularScore).toBeGreaterThan(newScore);
  });

  test("reinforced old fact can outrank fresh unreinforced fact", () => {
    const oneWeekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const candidates: readonly ScoredCandidate[] = [
      {
        fact: createTestFact({
          id: "fresh",
          lastAccessed: now.toISOString(),
          accessCount: 0,
        }),
        entity: "test",
        score: 8.0,
      },
      {
        fact: createTestFact({
          id: "reinforced-old",
          lastAccessed: oneWeekAgo.toISOString(),
          accessCount: 20,
        }),
        entity: "test",
        score: 10.0,
      },
    ];

    const result = computeSalienceScores(candidates, now, { halfLifeDays });
    const freshScore = result.find((c) => c.fact.id === "fresh")?.score ?? 0;
    const reinforcedScore = result.find((c) => c.fact.id === "reinforced-old")?.score ?? 0;
    // Reinforced old fact (20 accesses, log(22)≈3.09) should beat fresh (0 accesses, log(2)≈0.69)
    // even with some decay (~0.85 at 7 days with 30-day half-life)
    expect(reinforcedScore).toBeGreaterThan(freshScore);
  });
});

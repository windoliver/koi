import { describe, expect, test } from "bun:test";
import {
  computeDecayScore,
  computeSalience,
  computeTypeRelevance,
  scoreMemories,
} from "../salience.js";
import type { ScannedMemory } from "../scan.js";

// ---------------------------------------------------------------------------
// computeDecayScore
// ---------------------------------------------------------------------------

describe("computeDecayScore", () => {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  test("returns 1.0 for age 0 (just updated)", () => {
    expect(computeDecayScore(now, now)).toBeCloseTo(1.0, 5);
  });

  test("returns ~0.5 at exactly one half-life (30 days default)", () => {
    const thirtyDaysAgo = now - 30 * MS_PER_DAY;
    expect(computeDecayScore(thirtyDaysAgo, now)).toBeCloseTo(0.5, 2);
  });

  test("returns ~0.25 at two half-lives (60 days default)", () => {
    const sixtyDaysAgo = now - 60 * MS_PER_DAY;
    expect(computeDecayScore(sixtyDaysAgo, now)).toBeCloseTo(0.25, 2);
  });

  test("clamps to 1.0 for future timestamps", () => {
    const future = now + 10 * MS_PER_DAY;
    expect(computeDecayScore(future, now)).toBeCloseTo(1.0, 5);
  });

  test("respects custom halfLifeDays", () => {
    const tenDaysAgo = now - 10 * MS_PER_DAY;
    expect(computeDecayScore(tenDaysAgo, now, 10)).toBeCloseTo(0.5, 2);
  });

  test("returns near-zero for very old memories", () => {
    const yearAgo = now - 365 * MS_PER_DAY;
    expect(computeDecayScore(yearAgo, now)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// computeTypeRelevance
// ---------------------------------------------------------------------------

describe("computeTypeRelevance", () => {
  test("returns default weights for each type", () => {
    expect(computeTypeRelevance("feedback")).toBe(1.2);
    expect(computeTypeRelevance("user")).toBe(1.0);
    expect(computeTypeRelevance("project")).toBe(1.0);
    expect(computeTypeRelevance("reference")).toBe(0.8);
  });

  test("uses custom weights when provided", () => {
    const weights = { user: 2.0, feedback: 0.5, project: 1.5, reference: 0.1 };
    expect(computeTypeRelevance("user", weights)).toBe(2.0);
    expect(computeTypeRelevance("feedback", weights)).toBe(0.5);
  });

  test("falls back to 1.0 for missing custom weight", () => {
    expect(computeTypeRelevance("user", { feedback: 1.5 })).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeSalience
// ---------------------------------------------------------------------------

describe("computeSalience", () => {
  test("returns product of decay and type relevance", () => {
    expect(computeSalience(0.5, 1.2)).toBeCloseTo(0.6, 5);
  });

  test("enforces floor when product is below it", () => {
    expect(computeSalience(0.01, 0.8)).toBe(0.1);
  });

  test("uses custom floor", () => {
    expect(computeSalience(0.01, 0.8, 0.05)).toBe(0.05);
  });

  test("product above floor is returned as-is", () => {
    expect(computeSalience(1.0, 1.2)).toBeCloseTo(1.2, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreMemories
// ---------------------------------------------------------------------------

describe("scoreMemories", () => {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  function makeMemory(
    type: "user" | "feedback" | "project" | "reference",
    daysAgo: number,
  ): ScannedMemory {
    return {
      record: {
        id: `mem-${type}-${daysAgo}` as import("@koi/core").MemoryRecordId,
        name: `${type} memory`,
        description: `A ${type} memory from ${daysAgo} days ago`,
        type,
        content: "some content",
        filePath: `${type}_${daysAgo}.md`,
        createdAt: now - daysAgo * MS_PER_DAY,
        updatedAt: now - daysAgo * MS_PER_DAY,
      },
      fileSize: 100,
    };
  }

  test("returns empty array for empty input", () => {
    expect(scoreMemories([], undefined, now)).toEqual([]);
  });

  test("sorts by salience descending", () => {
    const memories = [
      makeMemory("reference", 60), // low type weight + old = low salience
      makeMemory("feedback", 1), // high type weight + fresh = high salience
      makeMemory("user", 30), // medium
    ];

    const scored = scoreMemories(memories, undefined, now);
    expect(scored.length).toBe(3);
    const [first, second, third] = scored;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    expect(first!.salienceScore).toBeGreaterThan(second!.salienceScore);
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    expect(second!.salienceScore).toBeGreaterThan(third!.salienceScore);
  });

  test("fresh feedback outscores old reference", () => {
    const memories = [makeMemory("reference", 90), makeMemory("feedback", 0)];
    const scored = scoreMemories(memories, undefined, now);
    expect(scored[0]?.memory.record.type).toBe("feedback");
  });

  test("includes decay and type relevance in result", () => {
    const memories = [makeMemory("user", 0)];
    const scored = scoreMemories(memories, undefined, now);
    expect(scored[0]?.decayScore).toBeCloseTo(1.0, 5);
    expect(scored[0]?.typeRelevance).toBe(1.0);
  });
});

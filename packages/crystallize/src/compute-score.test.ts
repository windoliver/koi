import { describe, expect, test } from "bun:test";
import { computeCrystallizeScore } from "./compute-score.js";
import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCandidate(
  toolIds: readonly string[],
  occurrences: number,
  detectedAt: number,
): CrystallizationCandidate {
  const key = toolIds.join("|");
  return {
    ngram: { steps: toolIds.map((id) => ({ toolId: id })), key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt,
    suggestedName: toolIds.join("-then-"),
  };
}

// ---------------------------------------------------------------------------
// computeCrystallizeScore
// ---------------------------------------------------------------------------

describe("computeCrystallizeScore", () => {
  test("returns positive score for fresh candidate", () => {
    const candidate = createCandidate(["fetch", "parse"], 5, 1000);
    const score = computeCrystallizeScore(candidate, 1000);
    expect(score).toBeGreaterThan(0);
  });

  test("score increases with more occurrences", () => {
    const few = createCandidate(["fetch", "parse"], 3, 1000);
    const many = createCandidate(["fetch", "parse"], 10, 1000);
    const scoreFew = computeCrystallizeScore(few, 1000);
    const scoreMany = computeCrystallizeScore(many, 1000);
    expect(scoreMany).toBeGreaterThan(scoreFew);
  });

  test("score increases with more steps (higher stepsReduction)", () => {
    const short = createCandidate(["a", "b"], 5, 1000);
    const long = createCandidate(["a", "b", "c", "d"], 5, 1000);
    const scoreShort = computeCrystallizeScore(short, 1000);
    const scoreLong = computeCrystallizeScore(long, 1000);
    expect(scoreLong).toBeGreaterThan(scoreShort);
  });

  test("score decays with age", () => {
    const candidate = createCandidate(["fetch", "parse"], 5, 1000);
    const scoreFresh = computeCrystallizeScore(candidate, 1000);
    const scoreOld = computeCrystallizeScore(candidate, 1000 + 3_600_000);
    expect(scoreFresh).toBeGreaterThan(scoreOld);
  });

  test("score halves after one half-life", () => {
    const halfLife = 1_800_000; // default 30 min
    const candidate = createCandidate(["fetch", "parse"], 5, 0);
    const scoreFresh = computeCrystallizeScore(candidate, 0);
    const scoreHalved = computeCrystallizeScore(candidate, halfLife);
    expect(scoreHalved).toBeCloseTo(scoreFresh / 2, 5);
  });

  test("respects custom recencyHalfLifeMs", () => {
    const candidate = createCandidate(["fetch", "parse"], 5, 0);
    const customHalfLife = 60_000; // 1 minute
    const scoreFresh = computeCrystallizeScore(candidate, 0, {
      recencyHalfLifeMs: customHalfLife,
    });
    const scoreAfterHL = computeCrystallizeScore(candidate, customHalfLife, {
      recencyHalfLifeMs: customHalfLife,
    });
    expect(scoreAfterHL).toBeCloseTo(scoreFresh / 2, 5);
  });

  test("returns max score when detectedAt equals now (recency = 1.0)", () => {
    const candidate = createCandidate(["fetch", "parse", "save"], 4, 5000);
    const score = computeCrystallizeScore(candidate, 5000);
    // stepsReduction = 3 - 1 = 2, recency = 1.0
    expect(score).toBe(4 * 2 * 1.0);
  });

  test("stepsReduction is at least 1 for single-step n-gram", () => {
    const candidate = createCandidate(["fetch"], 5, 1000);
    const score = computeCrystallizeScore(candidate, 1000);
    // stepsReduction = max(1, 1-1) = 1, recency = 1.0
    expect(score).toBe(5);
  });

  test("handles negative age (future detectedAt) gracefully", () => {
    const candidate = createCandidate(["fetch", "parse"], 5, 2000);
    // now < detectedAt: ageMs = max(0, -1000) = 0
    const score = computeCrystallizeScore(candidate, 1000);
    const freshScore = computeCrystallizeScore(candidate, 2000);
    // Both should yield recency = 1.0
    expect(score).toBe(freshScore);
  });
});

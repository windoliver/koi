import { describe, expect, test } from "bun:test";
import { computeCurationScore, computeRecencyFactor } from "./scoring.js";
import type { AggregatedStats } from "./types.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function makeStats(overrides?: Partial<AggregatedStats>): AggregatedStats {
  return {
    identifier: "tool-a",
    kind: "tool_call",
    successes: 8,
    failures: 2,
    retries: 0,
    totalDurationMs: 500,
    invocations: 10,
    lastSeenMs: 1000,
    ...overrides,
  };
}

describe("computeRecencyFactor", () => {
  test("returns 1.0 for same timestamp", () => {
    const factor = computeRecencyFactor(1000, 1000, 0.01);
    expect(factor).toBeCloseTo(1.0, 10);
  });

  test("decays over time", () => {
    const now = 1000 + 10 * MS_PER_DAY;
    const factor = computeRecencyFactor(1000, now, 0.01);
    // exp(-0.01 * 10) ≈ 0.9048
    expect(factor).toBeCloseTo(0.9048, 3);
  });

  test("decays faster with higher lambda", () => {
    const now = 1000 + 10 * MS_PER_DAY;
    const slow = computeRecencyFactor(1000, now, 0.01);
    const fast = computeRecencyFactor(1000, now, 0.1);
    expect(fast).toBeLessThan(slow);
  });

  test("returns 1.0 when lambda is 0", () => {
    const now = 1000 + 100 * MS_PER_DAY;
    const factor = computeRecencyFactor(1000, now, 0);
    expect(factor).toBeCloseTo(1.0, 10);
  });

  test("handles future lastSeen gracefully (clamps to 0 days)", () => {
    const factor = computeRecencyFactor(2000, 1000, 0.01);
    expect(factor).toBeCloseTo(1.0, 10);
  });

  test("approaches 0 for very old entries", () => {
    const now = 1000 + 1000 * MS_PER_DAY;
    const factor = computeRecencyFactor(1000, now, 0.01);
    expect(factor).toBeLessThan(0.001);
  });
});

describe("computeCurationScore", () => {
  test("returns 0 for zero invocations", () => {
    const stats = makeStats({ invocations: 0 });
    expect(computeCurationScore(stats, 5, 1000, 0.01)).toBe(0);
  });

  test("returns 0 for zero session count", () => {
    const stats = makeStats();
    expect(computeCurationScore(stats, 0, 1000, 0.01)).toBe(0);
  });

  test("returns 0 for all failures", () => {
    const stats = makeStats({ successes: 0, failures: 10 });
    expect(computeCurationScore(stats, 5, 1000, 0.01)).toBe(0);
  });

  test("computes positive score for healthy stats", () => {
    const stats = makeStats({
      successes: 8,
      failures: 2,
      invocations: 10,
      lastSeenMs: 1000,
    });
    const score = computeCurationScore(stats, 5, 1000, 0.01);
    // frequency=2, successRate=0.8, recency=1.0 → score=min(1, 1.6) = 1.0
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("score is capped at 1.0", () => {
    const stats = makeStats({
      successes: 100,
      failures: 0,
      invocations: 100,
      lastSeenMs: 1000,
    });
    const score = computeCurationScore(stats, 1, 1000, 0.01);
    expect(score).toBe(1);
  });

  test("higher success rate produces higher score", () => {
    const highSuccess = makeStats({ successes: 9, failures: 1 });
    const lowSuccess = makeStats({ successes: 3, failures: 7 });
    const now = 1000;
    const high = computeCurationScore(highSuccess, 5, now, 0.01);
    const low = computeCurationScore(lowSuccess, 5, now, 0.01);
    expect(high).toBeGreaterThan(low);
  });

  test("more recent entries score higher", () => {
    const now = 1000 + 100 * MS_PER_DAY;
    const recent = makeStats({ lastSeenMs: now });
    const stale = makeStats({ lastSeenMs: 1000 });
    const recentScore = computeCurationScore(recent, 5, now, 0.01);
    const staleScore = computeCurationScore(stale, 5, now, 0.01);
    expect(recentScore).toBeGreaterThan(staleScore);
  });

  test("higher frequency produces higher score", () => {
    const frequent = makeStats({ invocations: 20, successes: 16, failures: 4 });
    const rare = makeStats({ invocations: 2, successes: 2, failures: 0 });
    const score1 = computeCurationScore(frequent, 10, 1000, 0.01);
    const score2 = computeCurationScore(rare, 10, 1000, 0.01);
    expect(score1).toBeGreaterThan(score2);
  });

  test("score is between 0 and 1 inclusive", () => {
    const scenarios = [
      makeStats({ successes: 1, failures: 0, invocations: 1 }),
      makeStats({ successes: 50, failures: 50, invocations: 100 }),
      makeStats({ successes: 100, failures: 0, invocations: 100 }),
      makeStats({ successes: 0, failures: 100, invocations: 100 }),
    ];
    for (const stats of scenarios) {
      const score = computeCurationScore(stats, 5, 1000, 0.01);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("table-driven: known score calculations", () => {
    const cases: ReadonlyArray<{
      readonly stats: AggregatedStats;
      readonly sessions: number;
      readonly expected: number;
    }> = [
      {
        // frequency=2, successRate=1.0, recency=1.0 → min(1, 2) = 1
        stats: makeStats({
          invocations: 10,
          successes: 10,
          failures: 0,
          lastSeenMs: 1000,
        }),
        sessions: 5,
        expected: 1.0,
      },
      {
        // frequency=1, successRate=0.5, recency=1.0 → 0.5
        stats: makeStats({
          invocations: 10,
          successes: 5,
          failures: 5,
          lastSeenMs: 1000,
        }),
        sessions: 10,
        expected: 0.5,
      },
    ];

    for (const { stats, sessions, expected } of cases) {
      const score = computeCurationScore(stats, sessions, 1000, 0.01);
      expect(score).toBeCloseTo(expected, 2);
    }
  });
});

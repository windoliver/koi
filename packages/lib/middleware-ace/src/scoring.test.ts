import { describe, expect, test } from "bun:test";

import type { AggregatedStats } from "@koi/ace-types";

import { computeCurationScore, computeRecencyFactor } from "./scoring.js";

const baseStats: AggregatedStats = {
  identifier: "fs.read",
  kind: "tool_call",
  successes: 8,
  failures: 2,
  retries: 0,
  totalDurationMs: 1000,
  invocations: 10,
  lastSeenMs: 0,
};

const DAY = 1000 * 60 * 60 * 24;

describe("computeRecencyFactor", () => {
  test("returns 1 when nowMs equals lastSeenMs", () => {
    expect(computeRecencyFactor(0, 0, 0.1)).toBe(1);
  });

  test("decays exponentially with days elapsed", () => {
    const factor = computeRecencyFactor(0, 5 * DAY, 0.1);
    expect(factor).toBeCloseTo(Math.exp(-0.5));
  });

  test("clamps negative deltas to zero (future lastSeen)", () => {
    expect(computeRecencyFactor(2 * DAY, 0, 0.1)).toBe(1);
  });
});

describe("computeCurationScore", () => {
  test("returns 0 when no invocations", () => {
    const stats: AggregatedStats = { ...baseStats, invocations: 0 };
    expect(computeCurationScore(stats, 5, 0, 0.1)).toBe(0);
  });

  test("returns 0 when sessionCount is 0", () => {
    expect(computeCurationScore(baseStats, 0, 0, 0.1)).toBe(0);
  });

  test("clamps to 1 when frequency × successRate × recency exceeds 1", () => {
    // invocations 100 / sessionCount 1 = freq 100; success 1.0; recency 1.0
    const stats: AggregatedStats = {
      ...baseStats,
      successes: 100,
      failures: 0,
      invocations: 100,
    };
    expect(computeCurationScore(stats, 1, 0, 0)).toBe(1);
  });

  test("multiplies frequency × successRate × recency", () => {
    // invocations 10, sessionCount 5 → freq 2; successRate 0.8; recency 1
    // 2 × 0.8 × 1 = 1.6 → clamped to 1
    expect(computeCurationScore(baseStats, 5, 0, 0)).toBe(1);
    // freq 1; successRate 0.8; recency exp(-0.1)
    expect(computeCurationScore(baseStats, 10, 1 * DAY, 0.1)).toBeCloseTo(0.8 * Math.exp(-0.1));
  });
});

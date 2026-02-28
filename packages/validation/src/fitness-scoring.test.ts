import { describe, expect, test } from "bun:test";
import type { BrickFitnessMetrics, TrustTier } from "@koi/core";
import { DEFAULT_BRICK_FITNESS } from "@koi/core";
import { createTestToolArtifact } from "@koi/test-utils";
import {
  computeBrickFitness,
  DEFAULT_FITNESS_SCORING_CONFIG,
  evaluateTrustDecay,
} from "./fitness-scoring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed reference point
const MS_PER_DAY = 86_400_000;

function createMetrics(overrides?: Partial<BrickFitnessMetrics>): BrickFitnessMetrics {
  return {
    successCount: 10,
    errorCount: 0,
    latency: { samples: [50, 100, 150], count: 3, cap: 200 },
    lastUsedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Zero-usage edge case
// ---------------------------------------------------------------------------

describe("computeBrickFitness", () => {
  test("returns 0 for zero-usage brick", () => {
    expect(computeBrickFitness(DEFAULT_BRICK_FITNESS, NOW)).toBe(0);
  });

  test("returns 0 when both successCount and errorCount are 0", () => {
    const metrics = createMetrics({ successCount: 0, errorCount: 0 });
    expect(computeBrickFitness(metrics, NOW)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Success rate factor
  // ---------------------------------------------------------------------------

  test("100% success rate gives maximum success factor", () => {
    const perfect = createMetrics({ successCount: 10, errorCount: 0, lastUsedAt: NOW });
    const imperfect = createMetrics({ successCount: 8, errorCount: 2, lastUsedAt: NOW });
    const perfectScore = computeBrickFitness(perfect, NOW);
    const imperfectScore = computeBrickFitness(imperfect, NOW);
    expect(perfectScore).toBeGreaterThan(imperfectScore);
  });

  test("50% success rate with exponent 2 gives 0.25 success factor", () => {
    const metrics = createMetrics({
      successCount: 5,
      errorCount: 5,
      lastUsedAt: NOW,
      latency: { samples: [], count: 0, cap: 200 },
    });
    const score = computeBrickFitness(metrics, NOW, { successExponent: 2.0 });
    // successFactor = 0.5^2 = 0.25
    // recencyFactor = 1 (just used)
    // usageNorm = log2(11) / log2(101) ≈ 0.519
    // latencyFactor = 1 (no latency data)
    // score ≈ 0.25 * 1 * 0.519 * 1 ≈ 0.130
    expect(score).toBeGreaterThan(0.1);
    expect(score).toBeLessThan(0.2);
  });

  test("0% success rate gives score of 0", () => {
    const metrics = createMetrics({ successCount: 0, errorCount: 10, lastUsedAt: NOW });
    expect(computeBrickFitness(metrics, NOW)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Recency factor
  // ---------------------------------------------------------------------------

  test("recently used brick scores higher than stale brick", () => {
    const recent = createMetrics({ lastUsedAt: NOW });
    const stale = createMetrics({ lastUsedAt: NOW - 60 * MS_PER_DAY });
    expect(computeBrickFitness(recent, NOW)).toBeGreaterThan(computeBrickFitness(stale, NOW));
  });

  test("brick used exactly one half-life ago scores ~50% of recent", () => {
    const halfLifeDays = 30;
    const recent = createMetrics({ lastUsedAt: NOW });
    const halfLife = createMetrics({ lastUsedAt: NOW - halfLifeDays * MS_PER_DAY });
    const recentScore = computeBrickFitness(recent, NOW, { halfLifeDays });
    const halfLifeScore = computeBrickFitness(halfLife, NOW, { halfLifeDays });
    // recency factor should be ~0.5 at half-life
    const ratio = halfLifeScore / recentScore;
    expect(ratio).toBeCloseTo(0.5, 1);
  });

  test("future lastUsedAt is clamped to elapsed=0", () => {
    const metrics = createMetrics({ lastUsedAt: NOW + 1000 });
    const score = computeBrickFitness(metrics, NOW);
    const atNow = computeBrickFitness(createMetrics({ lastUsedAt: NOW }), NOW);
    expect(score).toBeCloseTo(atNow, 10);
  });

  // ---------------------------------------------------------------------------
  // Usage normalization factor
  // ---------------------------------------------------------------------------

  test("more usage increases score", () => {
    const low = createMetrics({ successCount: 2, errorCount: 0, lastUsedAt: NOW });
    const high = createMetrics({ successCount: 50, errorCount: 0, lastUsedAt: NOW });
    expect(computeBrickFitness(high, NOW)).toBeGreaterThan(computeBrickFitness(low, NOW));
  });

  test("score approaches 1 near saturation with perfect metrics", () => {
    const metrics = createMetrics({
      successCount: 100,
      errorCount: 0,
      lastUsedAt: NOW,
      latency: { samples: [10], count: 1, cap: 200 },
    });
    const score = computeBrickFitness(metrics, NOW, { usageSaturation: 100 });
    // usageNorm = log2(101) / log2(101) = 1.0
    // All other factors ≈ 1
    expect(score).toBeGreaterThan(0.9);
  });

  // ---------------------------------------------------------------------------
  // Latency factor
  // ---------------------------------------------------------------------------

  test("low latency gives near-maximum latency factor", () => {
    const fast = createMetrics({
      latency: { samples: [10, 20, 30], count: 3, cap: 200 },
      lastUsedAt: NOW,
    });
    const slow = createMetrics({
      latency: { samples: [4000, 4500, 5000], count: 3, cap: 200 },
      lastUsedAt: NOW,
    });
    expect(computeBrickFitness(fast, NOW)).toBeGreaterThan(computeBrickFitness(slow, NOW));
  });

  test("latency at maxAcceptableLatencyMs gives maximum penalty", () => {
    const fast = createMetrics({
      latency: { samples: [0], count: 1, cap: 200 },
      lastUsedAt: NOW,
    });
    const maxLatency = createMetrics({
      latency: { samples: [5000], count: 1, cap: 200 },
      lastUsedAt: NOW,
    });
    const fastScore = computeBrickFitness(fast, NOW);
    const slowScore = computeBrickFitness(maxLatency, NOW);
    // latencyFactor = 1 - 0.1 * 1 = 0.9 for max latency
    const ratio = slowScore / fastScore;
    expect(ratio).toBeCloseTo(0.9, 1);
  });

  test("no latency samples gives latencyFactor of 1", () => {
    const withLatency = createMetrics({
      latency: { samples: [1000], count: 1, cap: 200 },
      lastUsedAt: NOW,
    });
    const noLatency = createMetrics({
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: NOW,
    });
    // noLatency should score slightly higher (latencyFactor = 1 vs < 1)
    expect(computeBrickFitness(noLatency, NOW)).toBeGreaterThanOrEqual(
      computeBrickFitness(withLatency, NOW),
    );
  });

  // ---------------------------------------------------------------------------
  // Config overrides
  // ---------------------------------------------------------------------------

  test("custom config overrides defaults", () => {
    const metrics = createMetrics({ lastUsedAt: NOW });
    const defaultScore = computeBrickFitness(metrics, NOW);
    const customScore = computeBrickFitness(metrics, NOW, { successExponent: 1.0 });
    // With exponent 1 instead of 2, successFactor is higher for same rate
    expect(customScore).toBeGreaterThanOrEqual(defaultScore);
  });

  test("default config is frozen", () => {
    expect(Object.isFrozen(DEFAULT_FITNESS_SCORING_CONFIG)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Score bounds
  // ---------------------------------------------------------------------------

  test("score is always in [0, 1]", () => {
    // Extremely high usage (usageNorm > 1 before clamping)
    const extreme = createMetrics({
      successCount: 10000,
      errorCount: 0,
      lastUsedAt: NOW,
      latency: { samples: [1], count: 1, cap: 200 },
    });
    const score = computeBrickFitness(extreme, NOW);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("score is non-negative for all-error brick", () => {
    const allErrors = createMetrics({
      successCount: 0,
      errorCount: 100,
      lastUsedAt: NOW,
    });
    expect(computeBrickFitness(allErrors, NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateTrustDecay
// ---------------------------------------------------------------------------

describe("evaluateTrustDecay", () => {
  function createBrickBase(trustTier: TrustTier, fitness: BrickFitnessMetrics | undefined) {
    return createTestToolArtifact({ trustTier, fitness });
  }

  test("high fitness + promoted → no demotion", () => {
    const brick = createBrickBase(
      "promoted",
      createMetrics({ successCount: 50, errorCount: 0, lastUsedAt: NOW }),
    );
    expect(evaluateTrustDecay(brick, NOW)).toBeUndefined();
  });

  test("low fitness + promoted → verified", () => {
    // 0% success rate → fitness score = 0 which is < 0.3
    const brick = createBrickBase(
      "promoted",
      createMetrics({ successCount: 0, errorCount: 50, lastUsedAt: NOW }),
    );
    expect(evaluateTrustDecay(brick, NOW)).toBe("verified");
  });

  test("very low fitness + verified → sandbox", () => {
    // 0% success rate → fitness score = 0 which is < 0.1
    const brick = createBrickBase(
      "verified",
      createMetrics({ successCount: 0, errorCount: 50, lastUsedAt: NOW }),
    );
    expect(evaluateTrustDecay(brick, NOW)).toBe("sandbox");
  });

  test("sandbox → never demoted (floor)", () => {
    const brick = createBrickBase(
      "sandbox",
      createMetrics({ successCount: 0, errorCount: 50, lastUsedAt: NOW }),
    );
    expect(evaluateTrustDecay(brick, NOW)).toBeUndefined();
  });

  test("no fitness data → no demotion", () => {
    const brick = createBrickBase("promoted", undefined);
    expect(evaluateTrustDecay(brick, NOW)).toBeUndefined();
  });

  test("zero usage → no demotion", () => {
    const brick = createBrickBase(
      "promoted",
      createMetrics({ successCount: 0, errorCount: 0, lastUsedAt: NOW }),
    );
    expect(evaluateTrustDecay(brick, NOW)).toBeUndefined();
  });

  test("moderate fitness + promoted → no demotion", () => {
    // 80% success rate with recent usage should give fitness > 0.3
    const brick = createBrickBase(
      "promoted",
      createMetrics({ successCount: 80, errorCount: 20, lastUsedAt: NOW }),
    );
    expect(evaluateTrustDecay(brick, NOW)).toBeUndefined();
  });

  test("moderate fitness + verified → no demotion to sandbox", () => {
    // 50% success rate → fitness ≈ 0.13 which is > 0.1
    const brick = createBrickBase(
      "verified",
      createMetrics({ successCount: 50, errorCount: 50, lastUsedAt: NOW }),
    );
    expect(evaluateTrustDecay(brick, NOW)).toBeUndefined();
  });
});

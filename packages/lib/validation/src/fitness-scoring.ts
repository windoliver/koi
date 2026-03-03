/**
 * Fitness scoring — multiplicative composite score for brick discovery ranking.
 *
 * Pure function operating on BrickFitnessMetrics from @koi/core.
 * All factors are in [0, 1]; the composite score is their product clamped to [0, 1].
 *
 * Formula:
 *   successRate^exponent × recencyDecay × usageNorm × latencyFactor
 */

import type { BrickArtifactBase, BrickFitnessMetrics, TrustTier } from "@koi/core";
import { computePercentile } from "./latency-sampler.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FitnessScoringConfig {
  /** Half-life in days for the recency decay factor. Default: 30. */
  readonly halfLifeDays: number;
  /** Usage count at which usageNorm reaches ~1. Default: 100. */
  readonly usageSaturation: number;
  /** Exponent applied to success rate. Higher = harsher penalty for errors. Default: 2.0. */
  readonly successExponent: number;
  /** Blend factor for P99 latency penalty (0 = ignore latency). Default: 0.1. */
  readonly latencyWeight: number;
  /** Latency threshold in ms above which the penalty is maximal. Default: 5000. */
  readonly maxAcceptableLatencyMs: number;
}

export const DEFAULT_FITNESS_SCORING_CONFIG: FitnessScoringConfig = Object.freeze({
  halfLifeDays: 30,
  usageSaturation: 100,
  successExponent: 2.0,
  latencyWeight: 0.1,
  maxAcceptableLatencyMs: 5000,
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Computes a composite fitness score for a brick based on its runtime metrics.
 *
 * Returns 0 for bricks with zero usage (no data = no fitness signal).
 * Returns a value in (0, 1] for bricks with usage data.
 *
 * @param metrics - Runtime fitness metrics from the brick.
 * @param nowMs - Current time in epoch ms (injectable for testability).
 * @param config - Optional partial config (merged with defaults).
 */
export function computeBrickFitness(
  metrics: BrickFitnessMetrics,
  nowMs: number,
  config?: Partial<FitnessScoringConfig>,
): number {
  const cfg: FitnessScoringConfig = { ...DEFAULT_FITNESS_SCORING_CONFIG, ...config };

  const totalCalls = metrics.successCount + metrics.errorCount;
  if (totalCalls === 0) {
    return 0;
  }

  // Success factor: successRate ^ exponent  →  [0, 1]
  const successRate = metrics.successCount / totalCalls;
  const successFactor = successRate ** cfg.successExponent;

  // Recency factor: exponential decay  →  (0, 1]
  const lambda = Math.LN2 / (cfg.halfLifeDays * MS_PER_DAY);
  const elapsed = Math.max(0, nowMs - metrics.lastUsedAt);
  const recencyFactor = Math.exp(-lambda * elapsed);

  // Usage normalization: log2(1 + totalCalls) / log2(1 + saturation)  →  [0, ~1]
  const usageNorm = Math.log2(1 + totalCalls) / Math.log2(1 + cfg.usageSaturation);

  // Latency factor: 1 - weight × min(1, p99 / max)  →  [1-weight, 1]
  const p99 = computePercentile(metrics.latency, 0.99) ?? 0;
  const latencyRatio = Math.min(1, p99 / cfg.maxAcceptableLatencyMs);
  const latencyFactor = 1 - cfg.latencyWeight * latencyRatio;

  return Math.min(1, successFactor * recencyFactor * usageNorm * latencyFactor);
}

// ---------------------------------------------------------------------------
// Trust decay evaluation — lazy check at brick load/discover time
// ---------------------------------------------------------------------------

/** Thresholds for fitness-based trust decay. */
export interface DecayThresholds {
  /** Fitness score below which a promoted brick should be demoted to verified. Default: 0.3. */
  readonly promotedDemotionThreshold: number;
  /** Fitness score below which a verified brick should be demoted to sandbox. Default: 0.1. */
  readonly verifiedDemotionThreshold: number;
}

export const DEFAULT_DECAY_THRESHOLDS: DecayThresholds = Object.freeze({
  promotedDemotionThreshold: 0.3,
  verifiedDemotionThreshold: 0.1,
});

/**
 * Evaluates whether a brick's fitness has decayed enough to warrant trust demotion.
 *
 * Returns the target tier if demotion is needed, `undefined` if no change.
 * This is a pure scoring function — callers are responsible for executing the demotion.
 *
 * Does NOT demote bricks with zero usage (no evidence = no demotion).
 */
export function evaluateTrustDecay(
  brick: BrickArtifactBase,
  nowMs: number,
  config?: Partial<FitnessScoringConfig>,
  thresholds?: Partial<DecayThresholds>,
): TrustTier | undefined {
  // No fitness data = no evidence = no demotion
  if (brick.fitness === undefined) return undefined;

  const totalCalls = brick.fitness.successCount + brick.fitness.errorCount;
  if (totalCalls === 0) return undefined;

  const score = computeBrickFitness(brick.fitness, nowMs, config);
  const decay: DecayThresholds = { ...DEFAULT_DECAY_THRESHOLDS, ...thresholds };

  if (brick.trustTier === "promoted" && score < decay.promotedDemotionThreshold) {
    return "verified";
  }

  if (brick.trustTier === "verified" && score < decay.verifiedDemotionThreshold) {
    return "sandbox";
  }

  // sandbox is floor — never demote further
  return undefined;
}

import { describe, expect, it } from "bun:test";
import { computeExaptationConfidence } from "./confidence.js";
import type { ExaptationThresholds } from "./types.js";

const DEFAULT_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  confidenceWeight: 0.8,
} as const;

describe("computeExaptationConfidence", () => {
  it("returns base divergence * weight when at threshold minimums", () => {
    // agentCount = minDivergentAgents, observationCount = minObservations
    // multipliers both = 1, so result = divergence * 1 * 1 * weight
    const result = computeExaptationConfidence(0.8, 2, 5, DEFAULT_THRESHOLDS);
    expect(result).toBeCloseTo(0.8 * 1 * 1 * 0.8);
  });

  it("scales up with more agents (capped at 2x)", () => {
    // Use low divergence (0.4) so doubling stays under clamp of 1
    // base = 0.4 * 1 * 1 * 0.8 = 0.32
    // doubled = 0.4 * 2 * 1 * 0.8 = 0.64
    const atThreshold = computeExaptationConfidence(0.4, 2, 5, DEFAULT_THRESHOLDS);
    const doubled = computeExaptationConfidence(0.4, 4, 5, DEFAULT_THRESHOLDS);
    expect(doubled).toBeCloseTo(atThreshold * 2);
  });

  it("caps agent multiplier at 2x", () => {
    const at4 = computeExaptationConfidence(0.5, 4, 5, DEFAULT_THRESHOLDS);
    const at10 = computeExaptationConfidence(0.5, 10, 5, DEFAULT_THRESHOLDS);
    // Both should have agent multiplier = 2 (capped)
    expect(at4).toBeCloseTo(at10);
  });

  it("scales up with more observations (capped at 2x)", () => {
    // Use low divergence (0.4) so doubling stays under clamp of 1
    const atThreshold = computeExaptationConfidence(0.4, 2, 5, DEFAULT_THRESHOLDS);
    const doubled = computeExaptationConfidence(0.4, 2, 10, DEFAULT_THRESHOLDS);
    expect(doubled).toBeCloseTo(atThreshold * 2);
  });

  it("caps observation multiplier at 2x", () => {
    const at10 = computeExaptationConfidence(0.5, 2, 10, DEFAULT_THRESHOLDS);
    const at100 = computeExaptationConfidence(0.5, 2, 100, DEFAULT_THRESHOLDS);
    expect(at10).toBeCloseTo(at100);
  });

  it("clamps result to maximum 1", () => {
    // High divergence + both multipliers at 2x = could exceed 1
    const result = computeExaptationConfidence(0.9, 10, 100, DEFAULT_THRESHOLDS);
    expect(result).toBe(1);
  });

  it("returns 0 when divergence is 0", () => {
    expect(computeExaptationConfidence(0, 5, 10, DEFAULT_THRESHOLDS)).toBe(0);
  });

  it("handles zero thresholds gracefully (multiplier defaults to 1)", () => {
    const zeroThresholds: ExaptationThresholds = {
      ...DEFAULT_THRESHOLDS,
      minDivergentAgents: 0,
      minObservations: 0,
    };
    const result = computeExaptationConfidence(0.8, 3, 5, zeroThresholds);
    expect(result).toBeCloseTo(0.8 * 1 * 1 * 0.8);
  });

  it("returns value between 0 and 1 for various inputs", () => {
    const cases = [
      [0.5, 1, 3],
      [0.7, 2, 5],
      [1.0, 3, 10],
      [0.1, 1, 1],
    ] as const;

    for (const [divergence, agents, observations] of cases) {
      const result = computeExaptationConfidence(
        divergence,
        agents,
        observations,
        DEFAULT_THRESHOLDS,
      );
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});

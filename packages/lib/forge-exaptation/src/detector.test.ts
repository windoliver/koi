import { describe, expect, test } from "bun:test";
import type { UsagePurposeObservation } from "@koi/core";
import { DEFAULT_EXAPTATION_THRESHOLDS, detectDrift, suggestAction } from "./detector.js";

function obs(
  agentId: string,
  divergenceScore: number,
  contextText = `ctx-${agentId}-${divergenceScore.toFixed(2)}`,
): UsagePurposeObservation {
  return { agentId, divergenceScore, contextText, observedAt: 1 };
}

describe("detectDrift", () => {
  test("artifact used as intended → no drift flag", () => {
    const observations = [
      obs("a1", 0.05),
      obs("a2", 0.1),
      obs("a3", 0.0),
      obs("a1", 0.2),
      obs("a2", 0.1),
    ];
    const report = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(report).toBeUndefined();
  });

  test("artifact used for new purpose by multiple agents → drift detected", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a2", 0.85),
      obs("a3", 0.95),
      obs("a1", 0.8),
      obs("a2", 0.9),
      obs("a3", 0.85),
    ];
    const report = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(report).toBeDefined();
    expect(report?.kind).toBe("purpose_drift");
    expect(report?.divergentAgents).toBe(3);
  });

  test("drift severity is scored in [0, 1]", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a2", 0.95),
      obs("a3", 0.9),
      obs("a1", 0.85),
      obs("a2", 0.92),
      obs("a3", 0.88),
    ];
    const report = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(report).toBeDefined();
    expect(report?.severity).toBeGreaterThan(0);
    expect(report?.severity).toBeLessThanOrEqual(1);
  });

  test("below minObservations → no drift", () => {
    const observations = [obs("a1", 0.9), obs("a2", 0.9)];
    expect(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS)).toBeUndefined();
  });

  test("only one agent diverging → no drift", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a1", 0.92),
      obs("a1", 0.91),
      obs("a1", 0.95),
      obs("a1", 0.93),
    ];
    expect(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS)).toBeUndefined();
  });

  test("one agent with sustained drift + a single noisy spike from a second agent → no drift", () => {
    // Regression: a one-off observation must not let a second agent count as
    // divergent and manufacture multi-agent evidence.
    const observations = [
      obs("a1", 0.9),
      obs("a1", 0.92),
      obs("a1", 0.91),
      obs("a1", 0.95),
      obs("a2", 0.7),
    ];
    expect(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS)).toBeUndefined();
  });

  test("non-finite observation is dropped, valid subset still scored", () => {
    // Regression: a single malformed sample must not suppress the whole
    // window. The remaining 5 valid observations clear all thresholds.
    const observations = [
      obs("a1", Number.NaN),
      obs("a1", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
    ];
    const report = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(report).toBeDefined();
    expect(report?.observationCount).toBe(5);
    expect(report?.divergentAgents).toBe(2);
  });

  test("out-of-range observation is dropped, valid subset still scored", () => {
    const observations = [
      obs("a1", 1.5),
      obs("a1", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
    ];
    const report = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(report).toBeDefined();
    expect(report?.observationCount).toBe(5);
  });

  test("after dropping invalid observations, fewer than minObservations → no drift", () => {
    const observations = [
      obs("a1", Number.NaN),
      obs("a2", Number.POSITIVE_INFINITY),
      obs("a1", 0.9),
      obs("a2", 0.9),
    ];
    expect(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS)).toBeUndefined();
  });

  test("zero minObservations threshold → no drift (rejects invalid config)", () => {
    const observations = [obs("a1", 0.9), obs("a2", 0.9), obs("a1", 0.9), obs("a2", 0.9)];
    expect(
      detectDrift(observations, { ...DEFAULT_EXAPTATION_THRESHOLDS, minObservations: 0 }),
    ).toBeUndefined();
  });

  test("zero minDivergentAgents threshold → no drift (rejects invalid config)", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a1", 0.9),
    ];
    expect(
      detectDrift(observations, { ...DEFAULT_EXAPTATION_THRESHOLDS, minDivergentAgents: 0 }),
    ).toBeUndefined();
  });

  test("non-integer threshold → no drift (rejects invalid config)", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a1", 0.9),
    ];
    expect(
      detectDrift(observations, { ...DEFAULT_EXAPTATION_THRESHOLDS, minObservations: 2.5 }),
    ).toBeUndefined();
  });

  test("out-of-range divergenceThreshold → no drift", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a1", 0.9),
    ];
    expect(
      detectDrift(observations, { ...DEFAULT_EXAPTATION_THRESHOLDS, divergenceThreshold: 1.5 }),
    ).toBeUndefined();
  });

  test("empty agentId observation is dropped, surviving subset evaluated", () => {
    const observations = [
      obs("", 0.9),
      obs("a1", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
    ];
    const report = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(report).toBeDefined();
    expect(report?.observationCount).toBe(5);
  });
});

describe("suggestAction", () => {
  test("no report → no suggestion", () => {
    expect(suggestAction(undefined, 1)).toEqual({ kind: "none" });
  });

  test("significant drift → reclassify", () => {
    const report = {
      kind: "purpose_drift" as const,
      severity: 0.6,
      avgDivergence: 0.75,
      divergentAgents: 2,
      observationCount: 5,
    };
    expect(suggestAction(report, 1)).toEqual({
      kind: "reclassify",
      severity: 0.6,
    });
  });

  test("stable drift across multiple windows → new artifact suggestion", () => {
    const report = {
      kind: "purpose_drift" as const,
      severity: 0.85,
      avgDivergence: 0.92,
      divergentAgents: 4,
      observationCount: 12,
    };
    expect(suggestAction(report, 3)).toEqual({
      kind: "new-artifact",
      severity: 0.85,
    });
  });

  test("high severity but unstable (single window) → reclassify, not new artifact", () => {
    const report = {
      kind: "purpose_drift" as const,
      severity: 0.9,
      avgDivergence: 0.95,
      divergentAgents: 4,
      observationCount: 10,
    };
    expect(suggestAction(report, 1).kind).toBe("reclassify");
  });
});

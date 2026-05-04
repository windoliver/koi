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

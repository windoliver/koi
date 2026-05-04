import { describe, expect, test } from "bun:test";
import type { UsagePurposeObservation } from "@koi/core";
import {
  DEFAULT_EXAPTATION_THRESHOLDS,
  type DetectionResult,
  type DriftReport,
  detectDrift,
  suggestAction,
} from "./detector.js";

function obs(
  agentId: string,
  divergenceScore: number,
  contextText = `ctx-${agentId}-${divergenceScore.toFixed(2)}`,
): UsagePurposeObservation {
  return { agentId, divergenceScore, contextText, observedAt: 1 };
}

function expectDrift(result: DetectionResult): DriftReport {
  expect(result.kind).toBe("drift");
  if (result.kind !== "drift") throw new Error("expected drift");
  return result.report;
}

function expectNoDrift(result: DetectionResult): {
  observationCount: number;
  droppedCount: number;
} {
  expect(result.kind).toBe("no-drift");
  if (result.kind !== "no-drift") throw new Error("expected no-drift");
  return { observationCount: result.observationCount, droppedCount: result.droppedCount };
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
    expectNoDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
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
    const report = expectDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
    expect(report.kind).toBe("purpose_drift");
    expect(report.divergentAgents).toBe(3);
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
    const report = expectDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
    expect(report.severity).toBeGreaterThan(0);
    expect(report.severity).toBeLessThanOrEqual(1);
  });

  test("below minObservations → no-drift result with droppedCount=0", () => {
    const observations = [obs("a1", 0.9), obs("a2", 0.9)];
    const r = expectNoDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
    expect(r.observationCount).toBe(2);
    expect(r.droppedCount).toBe(0);
  });

  test("only one agent diverging → no drift", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a1", 0.92),
      obs("a1", 0.91),
      obs("a1", 0.95),
      obs("a1", 0.93),
    ];
    expectNoDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
  });

  test("one agent with sustained drift + a single noisy spike from a second agent → no drift", () => {
    const observations = [
      obs("a1", 0.9),
      obs("a1", 0.92),
      obs("a1", 0.91),
      obs("a1", 0.95),
      obs("a2", 0.7),
    ];
    expectNoDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
  });

  test("non-finite observation is dropped, valid subset still scored", () => {
    const observations = [
      obs("a1", Number.NaN),
      obs("a1", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    const report = expectDrift(result);
    expect(report.observationCount).toBe(5);
    expect(report.divergentAgents).toBe(2);
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
    const report = expectDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
    expect(report.observationCount).toBe(5);
  });

  test("after dropping invalid observations, fewer than minObservations → no-drift surfaces droppedCount", () => {
    const observations = [
      obs("a1", Number.NaN),
      obs("a2", Number.POSITIVE_INFINITY),
      obs("a1", 0.9),
      obs("a2", 0.9),
    ];
    const r = expectNoDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
    expect(r.droppedCount).toBe(2);
    expect(r.observationCount).toBe(2);
  });

  test("zero minObservations threshold → invalid-config", () => {
    const observations = [obs("a1", 0.9), obs("a2", 0.9), obs("a1", 0.9), obs("a2", 0.9)];
    const result = detectDrift(observations, {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      minObservations: 0,
    });
    expect(result.kind).toBe("invalid-config");
    if (result.kind === "invalid-config") expect(result.reason).toContain("minObservations");
  });

  test("zero minDivergentAgents threshold → invalid-config", () => {
    const observations = [obs("a1", 0.9), obs("a2", 0.9), obs("a1", 0.9), obs("a2", 0.9)];
    const result = detectDrift(observations, {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      minDivergentAgents: 0,
    });
    expect(result.kind).toBe("invalid-config");
  });

  test("non-integer threshold → invalid-config", () => {
    const observations = [obs("a1", 0.9), obs("a2", 0.9), obs("a1", 0.9), obs("a2", 0.9)];
    const result = detectDrift(observations, {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      minObservations: 2.5,
    });
    expect(result.kind).toBe("invalid-config");
  });

  test("out-of-range divergenceThreshold → invalid-config", () => {
    const observations = [obs("a1", 0.9), obs("a2", 0.9), obs("a1", 0.9), obs("a2", 0.9)];
    const result = detectDrift(observations, {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      divergenceThreshold: 1.5,
    });
    expect(result.kind).toBe("invalid-config");
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
    const report = expectDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
    expect(report.observationCount).toBe(5);
  });
});

describe("suggestAction", () => {
  test("no report → no suggestion", () => {
    expect(suggestAction(undefined, 1)).toEqual({ kind: "none" });
  });

  test("no-drift result → no suggestion", () => {
    expect(suggestAction({ kind: "no-drift", observationCount: 3, droppedCount: 0 }, 5)).toEqual({
      kind: "none",
    });
  });

  test("invalid-config result → no suggestion", () => {
    expect(suggestAction({ kind: "invalid-config", reason: "x" }, 5)).toEqual({ kind: "none" });
  });

  test("borderline drift → reclassify (not new-artifact, even when stable)", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 1,
      avgDivergence: 0.75,
      divergentAgents: 2,
      observationCount: 5,
    };
    expect(suggestAction(report, 5).kind).toBe("reclassify");
  });

  test("stable + raw divergence ≥ 0.85 → new-artifact", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 0.85,
      avgDivergence: 0.92,
      divergentAgents: 4,
      observationCount: 12,
    };
    expect(suggestAction(report, 3)).toEqual({ kind: "new-artifact", severity: 0.85 });
  });

  test("strong drift but unstable (single window) → reclassify", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 0.95,
      avgDivergence: 0.95,
      divergentAgents: 4,
      observationCount: 10,
    };
    expect(suggestAction(report, 1).kind).toBe("reclassify");
  });

  test("regression: minimum-threshold drift cannot escalate to new-artifact via volume", () => {
    // avgDivergence = 0.7 (just at detection threshold), heavy traffic.
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 1.0, // saturated by volume
      avgDivergence: 0.7,
      divergentAgents: 8,
      observationCount: 50,
    };
    // Despite saturated severity and many windows, raw divergence is 0.7 < 0.85.
    expect(suggestAction(report, 10).kind).toBe("reclassify");
  });

  test("accepts DetectionResult of kind drift", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 0.9,
      avgDivergence: 0.92,
      divergentAgents: 3,
      observationCount: 8,
    };
    const result: DetectionResult = { kind: "drift", report };
    expect(suggestAction(result, 3).kind).toBe("new-artifact");
  });
});

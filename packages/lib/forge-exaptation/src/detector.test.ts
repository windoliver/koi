import { describe, expect, test } from "bun:test";
import type { UsagePurposeObservation } from "@koi/core";
import {
  DEFAULT_EXAPTATION_THRESHOLDS,
  type DetectionResult,
  type DriftReport,
  detectDrift,
  suggestAction,
} from "./detector.js";

// Each obs() call gets a fresh, unique eventId — so by default tests
// produce replay-protected windows. Tests that need to exercise the
// no-eventId path use obsNoId().
let obsClock = 0;
function obs(
  agentId: string,
  divergenceScore: number,
  contextText?: string,
): UsagePurposeObservation {
  obsClock += 1;
  return {
    agentId,
    divergenceScore,
    contextText: contextText ?? `ctx-${agentId}-${String(obsClock)}`,
    observedAt: obsClock,
    eventId: `evt-${String(obsClock)}`,
  };
}

function obsNoId(
  agentId: string,
  divergenceScore: number,
  contextText?: string,
): UsagePurposeObservation {
  obsClock += 1;
  return {
    agentId,
    divergenceScore,
    contextText: contextText ?? `ctx-${agentId}-${String(obsClock)}`,
    observedAt: obsClock,
  };
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

function asResult(report: DriftReport): DetectionResult {
  return {
    kind: "drift",
    report,
    droppedCount: 0,
    duplicateCount: 0,
    validObservationCount: report.observationCount,
    replayProtected: true,
  };
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

  test("mixed traffic: divergent cohort surfaces even when baseline traffic dominates the window", () => {
    // Regression: previously the global avgDivergence gate hid drift when
    // most observations were normal-purpose. Now the detector scores drift
    // on the divergent cohort only — but the cohort itself must clear
    // minObservations.
    const observations = [
      // Baseline traffic: 6 agents, 1 obs each, very low divergence.
      obs("baseline-1", 0.05),
      obs("baseline-2", 0.05),
      obs("baseline-3", 0.05),
      obs("baseline-4", 0.05),
      obs("baseline-5", 0.05),
      obs("baseline-6", 0.05),
      // Divergent cohort: 2 agents, ≥3 obs each at 0.9 — cohort.observationCount = 6 ≥ 5.
      obs("d1", 0.9),
      obs("d1", 0.92),
      obs("d1", 0.91),
      obs("d2", 0.9),
      obs("d2", 0.91),
      obs("d2", 0.93),
    ];
    const report = expectDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
    expect(report.divergentAgents).toBe(2);
    expect(report.observationCount).toBe(6); // cohort only
    expect(report.avgDivergence).toBeGreaterThan(0.85);
  });

  test("mixed traffic: too-small divergent cohort → no drift (cohort minObservations gate)", () => {
    // Regression: a 4-observation cohort no longer triggers drift just
    // because baseline traffic pads the total window above minObservations.
    const observations = [
      obs("baseline-1", 0.05),
      obs("baseline-2", 0.05),
      obs("baseline-3", 0.05),
      obs("baseline-4", 0.05),
      obs("baseline-5", 0.05),
      obs("baseline-6", 0.05),
      obs("d1", 0.9),
      obs("d1", 0.92),
      obs("d2", 0.9),
      obs("d2", 0.91),
    ];
    expectNoDrift(detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS));
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
    expect(
      suggestAction(
        {
          kind: "no-drift",
          observationCount: 3,
          validObservationCount: 3,
          droppedCount: 0,
          duplicateCount: 0,
          replayProtected: true,
        },
        5,
      ),
    ).toEqual({ kind: "none" });
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
    expect(suggestAction(asResult(report), 5).kind).toBe("reclassify");
  });

  test("stable + raw divergence ≥ 0.85 → new-artifact", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 0.85,
      avgDivergence: 0.92,
      divergentAgents: 4,
      observationCount: 12,
    };
    expect(suggestAction(asResult(report), 3)).toEqual({ kind: "new-artifact", severity: 0.85 });
  });

  test("strong drift but unstable (single window) → reclassify", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 0.95,
      avgDivergence: 0.95,
      divergentAgents: 4,
      observationCount: 10,
    };
    expect(suggestAction(asResult(report), 1).kind).toBe("reclassify");
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
    expect(suggestAction(asResult(report), 10).kind).toBe("reclassify");
  });

  test("accepts DetectionResult of kind drift", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 0.9,
      avgDivergence: 0.92,
      divergentAgents: 3,
      observationCount: 8,
    };
    const result: DetectionResult = {
      kind: "drift",
      report,
      droppedCount: 0,
      duplicateCount: 0,
      validObservationCount: report.observationCount,
      replayProtected: true,
    };
    expect(suggestAction(result, 3).kind).toBe("new-artifact");
  });
});

describe("suggestAction replay-protection gate", () => {
  test("unprotected drift result (no observationKey) → none", () => {
    // Detector run without observationKey produces replayProtected: false.
    const result: DetectionResult = {
      kind: "drift",
      droppedCount: 0,
      duplicateCount: 0,
      validObservationCount: 5,
      replayProtected: false,
      report: {
        kind: "purpose_drift",
        severity: 0.95,
        avgDivergence: 0.92,
        divergentAgents: 4,
        observationCount: 5,
      },
    };
    expect(suggestAction(result, 5)).toEqual({ kind: "none" });
  });
});

describe("eventId-based dedup + replay protection", () => {
  test("missing eventId on any observation disables replay protection (no dedup)", () => {
    // Even one obsNoId() in the window flips replayProtected off.
    const observations = [...Array.from({ length: 6 }, () => obs("a", 0.9)), obsNoId("b", 0.9)];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift" || result.kind === "no-drift") {
      expect(result.replayProtected).toBe(false);
      expect(result.duplicateCount).toBe(0);
    }
  });

  test("every observation carrying eventId enables replay protection + per-agent dedup", () => {
    // Identical eventId from same agent collapses; same eventId across agents
    // survives (per-agent scope).
    const sharedId = "shared-eid";
    const a1: UsagePurposeObservation = {
      agentId: "a1",
      divergenceScore: 0.95,
      contextText: "ctx",
      observedAt: 1,
      eventId: sharedId,
    };
    const a2: UsagePurposeObservation = { ...a1, agentId: "a2" };
    const result = detectDrift([a1, a1, a1, a2, a2, a2], DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("no-drift");
    if (result.kind === "no-drift") {
      expect(result.replayProtected).toBe(true);
      expect(result.observationCount).toBe(2);
      expect(result.duplicateCount).toBe(4);
    }
  });

  test("empty-string eventId is treated as missing (not replay-protected)", () => {
    const observations = Array.from({ length: 6 }, () => ({
      ...obs("a", 0.9),
      eventId: "",
    }));
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift" || result.kind === "no-drift") {
      expect(result.replayProtected).toBe(false);
    }
  });

  test("duplicateCount reported on drift branch too", () => {
    const a1 = (eid: string, score = 0.9): UsagePurposeObservation => ({
      agentId: "a1",
      divergenceScore: score,
      contextText: "x",
      observedAt: 1,
      eventId: eid,
    });
    const a2 = (eid: string): UsagePurposeObservation => ({ ...a1(eid), agentId: "a2" });
    const a3 = (eid: string): UsagePurposeObservation => ({ ...a1(eid), agentId: "a3" });
    const observations = [
      a1("e1"),
      a1("e1"), // dup
      a1("e2"),
      a2("e3"),
      a2("e4"),
      a2("e4"), // dup
      a3("e5"),
      a3("e6"),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.duplicateCount).toBe(2);
      expect(result.droppedCount).toBe(0);
      expect(result.report.observationCount).toBe(6);
    }
  });

  test("droppedCount reported on drift branch too", () => {
    const observations: UsagePurposeObservation[] = [
      { ...obs("a1", 0.9), divergenceScore: Number.NaN }, // dropped
      obs("a1", 0.9),
      obs("a1", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
      obs("a2", 0.9),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.droppedCount).toBe(1);
      expect(result.duplicateCount).toBe(0);
    }
  });
});

describe("suggestAction quality gate", () => {
  test("low-quality drift result (>25% dropped) → none", () => {
    // 5 valid + 3 dropped → 3/8 = 37.5% degradation > 25%
    const result: DetectionResult = {
      kind: "drift",
      droppedCount: 3,
      duplicateCount: 0,
      validObservationCount: 5,
      replayProtected: true,
      report: {
        kind: "purpose_drift",
        severity: 0.95,
        avgDivergence: 0.92,
        divergentAgents: 4,
        observationCount: 5,
      },
    };
    expect(suggestAction(result, 5)).toEqual({ kind: "none" });
  });

  test("acceptable-quality drift result (<=25% dropped) → action", () => {
    // 5 valid + 1 dropped → 1/6 ≈ 16.7% < 25%
    const result: DetectionResult = {
      kind: "drift",
      droppedCount: 1,
      duplicateCount: 0,
      validObservationCount: 5,
      replayProtected: true,
      report: {
        kind: "purpose_drift",
        severity: 0.95,
        avgDivergence: 0.92,
        divergentAgents: 4,
        observationCount: 5,
      },
    };
    expect(suggestAction(result, 5).kind).toBe("new-artifact");
  });

  test("low-quality drift result (>25% duplicates) → none", () => {
    const result: DetectionResult = {
      kind: "drift",
      droppedCount: 0,
      duplicateCount: 4,
      validObservationCount: 5,
      replayProtected: true,
      report: {
        kind: "purpose_drift",
        severity: 0.95,
        avgDivergence: 0.92,
        divergentAgents: 4,
        observationCount: 5,
      },
    };
    expect(suggestAction(result, 5)).toEqual({ kind: "none" });
  });

  test("bare DriftReport bypasses quality gate (caller has no telemetry)", () => {
    const report: DriftReport = {
      kind: "purpose_drift",
      severity: 0.95,
      avgDivergence: 0.92,
      divergentAgents: 4,
      observationCount: 5,
    };
    expect(suggestAction(asResult(report), 5).kind).toBe("new-artifact");
  });
});

describe("eventId per-agent isolation regression", () => {
  test("identical eventId across different agents does not collapse them", () => {
    // Per-agent dedup namespace is `(agentId, eventId)`. A flat
    // `${agentId}|${eventId}` join would have a delimiter ambiguity bug.
    // Two distinct agents reporting the same (e.g. globally unique but
    // accidentally repeated) eventId must each survive.
    const sharedEid = "evt-shared";
    const samples = (agentId: string): UsagePurposeObservation[] => [
      { agentId, divergenceScore: 0.95, contextText: "x", observedAt: 1, eventId: sharedEid },
      { agentId, divergenceScore: 0.95, contextText: "y", observedAt: 2, eventId: sharedEid }, // dup
    ];
    const result = detectDrift([...samples("a"), ...samples("a b"), ...samples("a")], {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      minObservationsPerAgent: 1,
    });
    expect(result.kind).toBe("no-drift");
    if (result.kind === "no-drift") {
      // Each agent collapses to 1 (same eventId per-agent). 2 agents survive.
      expect(result.observationCount).toBe(2);
    }
  });
});

describe("eventId contract — actions only when replay-protected", () => {
  test("window without eventId can detect drift but suggestAction refuses to act", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obsNoId("a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obsNoId("b", s)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") expect(result.replayProtected).toBe(false);
    expect(suggestAction(result, 5)).toEqual({ kind: "none" });
  });

  test("every-observation-has-eventId window unlocks actions", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obs("a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("b", s)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") expect(result.replayProtected).toBe(true);
    expect(suggestAction(result, 5).kind).toBe("new-artifact");
  });
});

describe("cohort-share guard", () => {
  test("minority drift cohort + not stable + not strong → none (no reclassify)", () => {
    // 2 drifting agents (3 high-divergence each = 6) embedded in 14 baseline
    // observations from a third agent. Cohort share = 6/20 = 30% < 50%.
    // Without stableWindows ≥ 2 + avgDivergence ≥ 0.85, this would have been
    // a reclassify — overwriting canonical purpose for a minority pattern.
    const obsList: UsagePurposeObservation[] = [
      ...[0.75, 0.75, 0.75].map((s) => obs("a", s)),
      ...[0.75, 0.75, 0.75].map((s) => obs("b", s)),
      ...Array.from({ length: 14 }, () => obs("c", 0.05)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    expect(suggestAction(result, 1)).toEqual({ kind: "none" });
  });

  test("minority drift cohort + stable + strong → new-artifact (fork specialized variant)", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obs("a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("b", s)),
      ...Array.from({ length: 14 }, () => obs("c", 0.05)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    expect(suggestAction(result, 3).kind).toBe("new-artifact");
  });

  test("majority drift cohort → reclassify allowed", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.75, 0.75, 0.75].map((s) => obs("a", s)),
      ...[0.75, 0.75, 0.75].map((s) => obs("b", s)),
      ...Array.from({ length: 4 }, () => obs("c", 0.05)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    expect(suggestAction(result, 1).kind).toBe("reclassify");
  });
});

describe("observation-field validation (relaxed)", () => {
  test("non-finite observedAt does NOT drop the sample (telemetry-only field)", () => {
    // observedAt is descriptive metadata, not consumed by scoring or dedup.
    // Earlier versions used it in the default key and rejected NaN — that
    // created a silent observability blind spot under degraded telemetry.
    const observations = Array.from({ length: 6 }, () => ({
      ...obs("a", 0.95),
      observedAt: Number.NaN,
    }));
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift" || result.kind === "no-drift") {
      expect(result.droppedCount).toBe(0);
    }
  });

  test("missing agentId is still dropped (required for cohort attribution)", () => {
    const bad = { ...obs("", 0.9), agentId: "" };
    const result = detectDrift([bad, bad, bad], DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("no-drift");
    if (result.kind === "no-drift") expect(result.droppedCount).toBe(3);
  });
});

describe("mixed-traffic regressions", () => {
  test("agents mixing baseline + drift observations still surface drift", () => {
    // Two agents, each with 2 baseline (0.1) + 3 high-divergence (0.95) samples.
    // All-observations average is (2*0.1 + 3*0.95) / 5 = 0.61 < 0.7 — under the
    // old all-or-none rule the agents would have been excluded entirely and
    // drift would never surface.
    const obsList: UsagePurposeObservation[] = [
      ...[0.1, 0.1, 0.95, 0.95, 0.95].map((s) => obs("a", s)),
      ...[0.1, 0.1, 0.95, 0.95, 0.95].map((s) => obs("b", s)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      // Cohort = the 6 high-divergence samples only; baselines stay out.
      expect(result.report.divergentAgents).toBe(2);
      expect(result.report.observationCount).toBe(6);
      expect(result.report.avgDivergence).toBeCloseTo(0.95, 5);
      // Full window is still tracked.
      expect(result.validObservationCount).toBe(10);
    }
  });

  test("quality gate uses full validated window, not just cohort slice", () => {
    // 10 valid samples (6 cohort + 4 baseline) and 2 dropped. Old denominator
    // (cohort.observationCount = 6) would have computed 2/(6+2)=25% which is
    // not >25%. A new dropped sample (3) would push it to 3/(6+3)=33% wrongly.
    // New denominator uses validObservationCount = 10, giving 3/(10+3)≈23% — still acceptable.
    const result: DetectionResult = {
      kind: "drift",
      droppedCount: 3,
      duplicateCount: 0,
      validObservationCount: 10,
      replayProtected: true,
      report: {
        kind: "purpose_drift",
        severity: 0.95,
        avgDivergence: 0.92,
        divergentAgents: 2,
        observationCount: 6,
      },
    };
    expect(suggestAction(result, 5).kind).toBe("new-artifact");
  });
});

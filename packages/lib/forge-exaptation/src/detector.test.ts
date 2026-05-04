import { describe, expect, test } from "bun:test";
import type { UsagePurposeObservation } from "@koi/core";
import {
  DEFAULT_EXAPTATION_THRESHOLDS,
  type DetectionResult,
  type DriftReport,
  detectDrift,
  suggestAction,
} from "./detector.js";

// Each obs() call gets a unique observedAt so dedup never collapses
// independently-fed observations in tests. Real callers either control
// observedAt themselves or rely on monotonic clocks.
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

describe("detectDrift throwing observationKey", () => {
  test("a throwing keyFn drops the offending sample, not the whole window", () => {
    const a1: UsagePurposeObservation = {
      agentId: "a1",
      observedAt: 1,
      contextText: "ctx",
      divergenceScore: 0.9,
    };
    const a2: UsagePurposeObservation = { ...a1, agentId: "a2" };
    const observations = [a1, { ...a1, contextText: "throw-me" }, a1, a2, a2, a2];
    const result = detectDrift(observations, {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      observationKey: (o) => {
        if (o.contextText === "throw-me") throw new Error("boom");
        return `${o.agentId}|${o.contextText}`;
      },
    });
    expect(result.kind).not.toBe("invalid-config");
    if (result.kind === "drift" || result.kind === "no-drift") {
      expect(result.droppedCount).toBe(1);
    }
  });
});

describe("detectDrift dedup (opt-in) + telemetry", () => {
  test("default thresholds include DEFAULT_OBSERVATION_KEY (per-agent observedAt|contextText)", () => {
    // Identical (agentId, observedAt, contextText) tuples within an agent
    // collapse; identical payload from a different agent survives.
    const dup: UsagePurposeObservation = {
      agentId: "a1",
      observedAt: 1234,
      contextText: "ctx",
      divergenceScore: 0.95,
    };
    const dup2: UsagePurposeObservation = { ...dup, agentId: "a2" };
    const result = detectDrift([dup, dup, dup, dup2, dup2, dup2], DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("no-drift");
    if (result.kind === "no-drift") {
      expect(result.observationCount).toBe(2);
      expect(result.duplicateCount).toBe(4);
      expect(result.replayProtected).toBe(true);
    }
  });

  test("explicitly setting observationKey: undefined disables dedup → replayProtected: false", () => {
    const dup: UsagePurposeObservation = {
      agentId: "a1",
      observedAt: 1234,
      contextText: "ctx",
      divergenceScore: 0.95,
    };
    const dup2: UsagePurposeObservation = { ...dup, agentId: "a2" };
    const result = detectDrift([dup, dup, dup, dup2, dup2, dup2], {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      observationKey: undefined,
    });
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.replayProtected).toBe(false);
      expect(result.duplicateCount).toBe(0);
    }
  });

  test("opt-in dedup is scoped per-agent: identical payload across agents survives", () => {
    // Regression: an observationKey that ignores agentId (e.g. payload-only)
    // must not collapse identical observations from different agents — that
    // would erase the cross-agent evidence detectDrift requires.
    const a1: UsagePurposeObservation = {
      agentId: "a1",
      observedAt: 1,
      contextText: "same-payload",
      divergenceScore: 0.95,
    };
    const a2: UsagePurposeObservation = { ...a1, agentId: "a2", observedAt: 2 };
    const a3: UsagePurposeObservation = { ...a1, agentId: "a3", observedAt: 3 };
    // Caller's keyFn deliberately ignores agentId. Per-agent dedup still
    // keeps one observation per agent (3 agents × 1 obs each = 3).
    const observations = [
      a1,
      a1, // intra-agent replay → collapsed
      a2,
      a2, // intra-agent replay → collapsed
      a3,
      a3, // intra-agent replay → collapsed
      a1,
      a2,
      a3, // more cross-agent dupes → collapsed within each agent
    ];
    const result = detectDrift(observations, {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      minObservationsPerAgent: 1,
      observationKey: (o) => o.contextText, // payload-only key
    });
    // 3 agents, all divergent → drift would be detected if minObs were 3.
    // With default minObservations=5 we only need to confirm the surviving
    // count after dedup is 3 (one per agent), not 1.
    expect(result.kind).toBe("no-drift");
    if (result.kind === "no-drift") {
      expect(result.observationCount).toBe(3);
      expect(result.duplicateCount).toBe(6);
    }
  });

  test("opt-in dedup via observationKey collapses replays", () => {
    const dup: UsagePurposeObservation = {
      agentId: "a1",
      observedAt: 1234,
      contextText: "ctx",
      divergenceScore: 0.95,
    };
    const result = detectDrift([dup, dup, dup, dup, dup], {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      observationKey: (o) => `${o.agentId}|${String(o.observedAt)}|${o.contextText}`,
    });
    expect(result.kind).toBe("no-drift");
    if (result.kind === "no-drift") {
      expect(result.observationCount).toBe(1);
      expect(result.duplicateCount).toBe(4);
    }
  });

  test("duplicateCount is reported on the drift branch too (when dedup is enabled)", () => {
    const keyFn = (o: UsagePurposeObservation): string =>
      `${o.agentId}|${String(o.observedAt)}|${o.contextText}`;
    const observations: UsagePurposeObservation[] = [
      { agentId: "a1", observedAt: 1, contextText: "x", divergenceScore: 0.9 },
      { agentId: "a1", observedAt: 1, contextText: "x", divergenceScore: 0.9 }, // dup
      { agentId: "a1", observedAt: 2, contextText: "y", divergenceScore: 0.9 },
      { agentId: "a2", observedAt: 3, contextText: "z", divergenceScore: 0.9 },
      { agentId: "a2", observedAt: 4, contextText: "w", divergenceScore: 0.9 },
      { agentId: "a2", observedAt: 4, contextText: "w", divergenceScore: 0.9 }, // dup
      { agentId: "a3", observedAt: 5, contextText: "v", divergenceScore: 0.9 },
      { agentId: "a3", observedAt: 6, contextText: "u", divergenceScore: 0.9 },
    ];
    const result = detectDrift(observations, {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      observationKey: keyFn,
    });
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.duplicateCount).toBe(2);
      expect(result.droppedCount).toBe(0);
      expect(result.report.observationCount).toBe(6);
    }
  });

  test("droppedCount is reported on the drift branch too", () => {
    const observations: UsagePurposeObservation[] = [
      { agentId: "a1", observedAt: 1, contextText: "x", divergenceScore: Number.NaN },
      { agentId: "a1", observedAt: 2, contextText: "y", divergenceScore: 0.9 },
      { agentId: "a1", observedAt: 3, contextText: "z", divergenceScore: 0.9 },
      { agentId: "a2", observedAt: 4, contextText: "w", divergenceScore: 0.9 },
      { agentId: "a2", observedAt: 5, contextText: "v", divergenceScore: 0.9 },
      { agentId: "a2", observedAt: 6, contextText: "u", divergenceScore: 0.9 },
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

describe("dedup key isolation regression", () => {
  test("agentId / key delimiter ambiguity does not collapse different agents", () => {
    // Regression: a flat `${agentId} ${key}` would let
    // agentId="a", key="b c" collide with agentId="a b", key="c". The
    // nested-Map dedup makes the (agentId, key) pair unambiguous.
    const a1: UsagePurposeObservation = {
      agentId: "a",
      observedAt: 1,
      contextText: "x",
      divergenceScore: 0.95,
    };
    const a1b: UsagePurposeObservation = {
      agentId: "a",
      observedAt: 2,
      contextText: "y",
      divergenceScore: 0.95,
    };
    const a2: UsagePurposeObservation = {
      agentId: "a b",
      observedAt: 3,
      contextText: "z",
      divergenceScore: 0.95,
    };
    const a2b: UsagePurposeObservation = {
      agentId: "a b",
      observedAt: 4,
      contextText: "w",
      divergenceScore: 0.95,
    };
    const result = detectDrift([a1, a1b, a2, a2b, a1, a2], {
      ...DEFAULT_EXAPTATION_THRESHOLDS,
      // Pathological key: a single space. Combined with the colliding
      // agentIds above, a flat space-delimited scope key would conflate
      // the two agents. Per-agent Map<Set> isolates them.
      observationKey: () => " ",
    });
    expect(result.kind).toBe("no-drift");
    if (result.kind === "no-drift") {
      // Each agent collapses to 1 obs (same key for everything within an agent).
      expect(result.observationCount).toBe(2);
      expect(result.duplicateCount).toBe(4);
    }
  });
});

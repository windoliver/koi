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

/**
 * Build a real (branded) drift DetectionResult by calling `detectDrift` with
 * crafted inputs. Tests use this instead of structurally-constructed result
 * literals — those are now rejected by the authenticity gate inside
 * `suggestAction`, by design.
 *
 * `score` controls cohort divergence; `agents` × `obsPerAgent` builds the
 * cohort; optional `baseline`, `drops`, `dups` add baseline traffic, malformed
 * observations, or same-eventId duplicates respectively.
 */
function buildDrift(opts: {
  readonly agents: number;
  readonly obsPerAgent: number;
  readonly score: number;
  readonly baseline?: number;
  readonly drops?: number;
  readonly dups?: number;
}): DetectionResult {
  const list: UsagePurposeObservation[] = [];
  for (let a = 0; a < opts.agents; a++) {
    for (let i = 0; i < opts.obsPerAgent; i++) {
      list.push(obs(`drift-${String(a)}`, opts.score));
    }
  }
  for (let i = 0; i < (opts.baseline ?? 0); i++) list.push(obs("baseline", 0.05));
  for (let i = 0; i < (opts.drops ?? 0); i++) {
    list.push({ ...obs("drift-0", 0.9), divergenceScore: Number.NaN });
  }
  if (opts.dups) {
    const seed = obs("drift-0", opts.score);
    for (let i = 0; i < opts.dups; i++) list.push(seed);
  }
  return detectDrift(list, DEFAULT_EXAPTATION_THRESHOLDS);
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
    // Build a no-drift result via real detectDrift (branded); structurally-
    // constructed objects are now rejected by the authenticity gate.
    const noDriftResult = detectDrift(
      [obs("a", 0.95), obs("b", 0.95)],
      DEFAULT_EXAPTATION_THRESHOLDS,
    );
    expect(noDriftResult.kind).toBe("no-drift");
    expect(suggestAction(noDriftResult, 5)).toEqual({ kind: "none" });
  });

  test("invalid-config result → no suggestion", () => {
    const invalid = detectDrift([], { ...DEFAULT_EXAPTATION_THRESHOLDS, minObservations: 0 });
    expect(invalid.kind).toBe("invalid-config");
    expect(suggestAction(invalid, 5)).toEqual({ kind: "none" });
  });

  test("borderline drift → reclassify (not new-artifact, even when stable)", () => {
    // avgDivergence=0.75 < 0.85 fork threshold.
    const result = buildDrift({ agents: 2, obsPerAgent: 3, score: 0.75 });
    expect(suggestAction(result, 5).kind).toBe("reclassify");
  });

  test("stable + raw divergence ≥ 0.85 → new-artifact", () => {
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92 });
    const action = suggestAction(result, 3);
    expect(action.kind).toBe("new-artifact");
  });

  test("strong drift but unstable (single window) → reclassify", () => {
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(suggestAction(result, 1).kind).toBe("reclassify");
  });

  test("regression: minimum-threshold drift cannot escalate to new-artifact via volume", () => {
    // avgDivergence at the detection floor (0.7), saturating severity by
    // volume — must NOT escalate to new-artifact regardless of stableWindows.
    const result = buildDrift({ agents: 8, obsPerAgent: 6, score: 0.7 });
    expect(suggestAction(result, 10).kind).toBe("reclassify");
  });

  test("accepts (real) DetectionResult of kind drift", () => {
    const result = buildDrift({ agents: 3, obsPerAgent: 3, score: 0.92 });
    expect(suggestAction(result, 3).kind).toBe("new-artifact");
  });

  test("DetectionResult survives JSON round-trip and still drives suggestAction", () => {
    // Pure-data contract: clone/serialize boundaries (worker IPC, persistence,
    // cross-package handoff) MUST NOT silently disable suggestions. The fields
    // are the contract; honest callers preserving them keep their
    // recommendations.
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92 });
    const cloned = JSON.parse(JSON.stringify(result)) as DetectionResult;
    expect(suggestAction(cloned, 3).kind).toBe("new-artifact");
  });
});

describe("suggestAction replay-protection gate", () => {
  test("unprotected drift result (observation without eventId) → none", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obsNoId("a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obsNoId("b", s)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") expect(result.replayProtected).toBe(false);
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
    // Same eventId from same agent collapses (replay). The L0 contract
    // requires eventId to be per-observation unique, so cross-agent
    // collisions are accidental and per-agent dedup keeps them independent.
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
      // Per-agent: each agent collapses 3 → 1, so 2 survive.
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
    // 12 valid (4 agents × 3 obs at 0.92) + 5 dropped → 5/17 ≈ 29% > 25%.
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92, drops: 5 });
    expect(suggestAction(result, 5)).toEqual({ kind: "none" });
  });

  test("acceptable-quality drift result (<=25% dropped) → action", () => {
    // 12 valid + 2 dropped → 2/14 ≈ 14% < 25%.
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92, drops: 2 });
    expect(suggestAction(result, 5).kind).toBe("new-artifact");
  });

  test("low-quality drift result (>25% duplicates) → none", () => {
    // 12 valid + 10 same-eventId duplicates that collapse → 10/22 ≈ 45% > 25%.
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92, dups: 10 });
    if (result.kind === "drift") {
      expect(result.duplicateCount).toBeGreaterThan(0);
      expect(suggestAction(result, 5)).toEqual({ kind: "none" });
    }
  });

  test("real branded drift result with no drops/dups passes quality gate", () => {
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92 });
    expect(suggestAction(result, 5).kind).toBe("new-artifact");
  });
});

describe("partial-eventId dedup", () => {
  test("missing eventId on one sample does not disable dedup for the rest", () => {
    // 3 same-eventId duplicates from a1 + 3 unique a1 + 3 unique a2 +
    // 1 obsNoId (which flips replayProtected to false but must NOT pass
    // the duplicate samples through unchecked).
    const dupSeed = obs("a1", 0.95);
    const observations: UsagePurposeObservation[] = [
      dupSeed,
      dupSeed,
      dupSeed,
      obs("a1", 0.95),
      obs("a1", 0.95),
      obs("a2", 0.95),
      obs("a2", 0.95),
      obs("a2", 0.95),
      obsNoId("a3", 0.05),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift" || result.kind === "no-drift") {
      expect(result.replayProtected).toBe(false);
      // 2 collapsed copies of dupSeed should still register as duplicates.
      expect(result.duplicateCount).toBe(2);
    }
  });
});

describe("non-finite observedAt dedup tiebreak", () => {
  test("equal-score duplicates with NaN observedAt fall through to contextText (order-independent)", () => {
    const eid = "shared";
    const a: UsagePurposeObservation = {
      agentId: "a1",
      eventId: eid,
      divergenceScore: 0.95,
      observedAt: Number.NaN,
      contextText: "alpha",
    };
    const b: UsagePurposeObservation = { ...a, contextText: "beta" };
    const padding: UsagePurposeObservation[] = [
      obs("a2", 0.95),
      obs("a2", 0.95),
      obs("a2", 0.95),
      obs("a3", 0.95),
      obs("a3", 0.95),
      obs("a3", 0.95),
    ];
    const r1 = detectDrift([a, b, ...padding], DEFAULT_EXAPTATION_THRESHOLDS);
    const r2 = detectDrift([b, a, ...padding], DEFAULT_EXAPTATION_THRESHOLDS);
    expect(r1.kind).toBe("drift");
    expect(r2.kind).toBe("drift");
    if (r1.kind === "drift" && r2.kind === "drift") {
      // Outcome is identical regardless of arrival order — NaN no longer
      // re-introduces first-write-wins.
      expect(r1.report.observationCount).toBe(r2.report.observationCount);
      expect(r1.report.avgDivergence).toBeCloseTo(r2.report.avgDivergence, 10);
    }
  });
});

describe("deep-freeze tamper resistance", () => {
  test("nested report fields are frozen — mutation cannot escalate suggestion", () => {
    // Build a sub-fork-threshold drift result. Without deep freeze, mutating
    // result.report.avgDivergence to push it above 0.85 would let suggestAction
    // return new-artifact on tampered data.
    const result = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.75 });
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(() => {
        // Strict mode (TS modules are strict) throws on writes to frozen.
        (result.report as { avgDivergence: number }).avgDivergence = 0.99;
      }).toThrow();
      expect(() => {
        (result.report as { severity: number }).severity = 1;
      }).toThrow();
      // Genuine value was not overwritten.
      expect(result.report.avgDivergence).toBeLessThan(0.85);
      expect(suggestAction(result, 5).kind).toBe("reclassify");
    }
  });
});

describe("deterministic dedup conflict resolution", () => {
  test("conflicting (agentId, eventId) duplicates resolve by max divergenceScore (not by arrival order)", () => {
    // Same (agentId, eventId) twice with different scores. Old first-write-
    // wins behaviour would let outcome depend on ingestion order. Deterministic
    // resolution picks the higher divergenceScore — so reordering inputs gives
    // the same DriftReport.observationCount and avgDivergence.
    const sharedEid = "evt-shared";
    const lo: UsagePurposeObservation = {
      agentId: "a1",
      eventId: sharedEid,
      divergenceScore: 0.4,
      contextText: "x",
      observedAt: 1,
    };
    const hi: UsagePurposeObservation = { ...lo, divergenceScore: 0.95 };
    const otherAgents: UsagePurposeObservation[] = [
      obs("a2", 0.95),
      obs("a2", 0.95),
      obs("a2", 0.95),
      obs("a3", 0.95),
      obs("a3", 0.95),
      obs("a3", 0.95),
    ];
    // Two ingestion orders for the same logical event set.
    const ordered = [lo, hi, ...otherAgents];
    const reverseOrdered = [hi, lo, ...otherAgents];
    const r1 = detectDrift(ordered, DEFAULT_EXAPTATION_THRESHOLDS);
    const r2 = detectDrift(reverseOrdered, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(r1.kind).toBe("drift");
    expect(r2.kind).toBe("drift");
    if (r1.kind === "drift" && r2.kind === "drift") {
      // Both runs win the same conflict (the high-score sample), so the
      // resulting DriftReport is identical.
      expect(r1.report.avgDivergence).toBeCloseTo(r2.report.avgDivergence, 10);
      expect(r1.report.observationCount).toBe(r2.report.observationCount);
    }
  });
});

describe("whitespace-only eventId is treated as missing", () => {
  test('eventId of " " or "\\n" does NOT enable replayProtected', () => {
    const observations: UsagePurposeObservation[] = [
      { ...obs("a1", 0.95), eventId: " " },
      { ...obs("a1", 0.95), eventId: "\t" },
      { ...obs("a1", 0.95), eventId: "\n" },
      { ...obs("a2", 0.95), eventId: "  " },
      { ...obs("a2", 0.95), eventId: "" },
      { ...obs("a2", 0.95), eventId: " " },
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift" || result.kind === "no-drift") {
      expect(result.replayProtected).toBe(false);
    }
    expect(suggestAction(result, 5)).toEqual({ kind: "none" });
  });

  test("eventIds varying only in surrounding whitespace still collapse", () => {
    // Upstream emitter sometimes pads keys; trim makes "foo" and "foo " the
    // same dedup bucket so retries still collapse.
    const make = (eventId: string, observedAt: number): UsagePurposeObservation => ({
      agentId: "a1",
      eventId,
      divergenceScore: 0.95,
      observedAt,
      contextText: "x",
    });
    const observations: UsagePurposeObservation[] = [
      make("foo", 1),
      make("foo ", 2),
      make(" foo", 3),
      make(" foo\n", 4),
      ...[0.95, 0.95, 0.95].map((s) => obs("a2", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("a3", s)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      // a1: 4 inputs collapse to 1 unique → fails minObservationsPerAgent=2
      // and is excluded from cohort. a2 + a3: 3 each = 6 cohort obs.
      expect(result.report.observationCount).toBe(6);
      expect(result.duplicateCount).toBe(3);
    }
  });
});

describe("eventId contract regressions", () => {
  test("multiple distinct tool calls in one request (each with its own eventId) all count as evidence", () => {
    // L0 contract: eventId is per-observation unique, not request-level.
    // Three tool calls within the same request from one agent produce three
    // distinct eventIds and three observations — none collapse.
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obs("a1", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("a2", s)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.report.observationCount).toBe(6);
      expect(result.duplicateCount).toBe(0);
    }
  });

  test("accidental cross-tenant eventId collision keeps observations independent (per-agent scope)", () => {
    // Two tenants happen to mint the same eventId string. Per-agent scope
    // (tenant-prefixed agentIds) keeps them as independent evidence rather
    // than collapsing them as duplicates. Earlier global-dedup attempt
    // would have erased real evidence here.
    const collidingId = "happens-to-collide";
    const observations: UsagePurposeObservation[] = [
      // tenantA — 2 distinct (legitimate) eventIds, plus a colliding-id replay.
      {
        agentId: "tenantA/agent-x",
        eventId: "a-evt-1",
        divergenceScore: 0.95,
        observedAt: 1,
        contextText: "x",
      },
      {
        agentId: "tenantA/agent-x",
        eventId: "a-evt-2",
        divergenceScore: 0.95,
        observedAt: 2,
        contextText: "x",
      },
      {
        agentId: "tenantA/agent-x",
        eventId: collidingId,
        divergenceScore: 0.95,
        observedAt: 3,
        contextText: "x",
      },
      // tenantB — also has a hit on the colliding eventId. Per-agent scope
      // keeps tenantB's evidence independent of tenantA's despite the collision.
      {
        agentId: "tenantB/agent-y",
        eventId: "b-evt-1",
        divergenceScore: 0.95,
        observedAt: 4,
        contextText: "x",
      },
      {
        agentId: "tenantB/agent-y",
        eventId: "b-evt-2",
        divergenceScore: 0.95,
        observedAt: 5,
        contextText: "x",
      },
      {
        agentId: "tenantB/agent-y",
        eventId: collidingId,
        divergenceScore: 0.95,
        observedAt: 6,
        contextText: "x",
      },
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      // Each tenant: 3 distinct eventIds in their per-agent scope. Both
      // tenants' evidence survives — global dedup would have collapsed
      // collidingId across tenants and undercount cohort.
      expect(result.report.observationCount).toBe(6);
      expect(result.report.divergentAgents).toBe(2);
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
    // 6-obs drift cohort + 4 baseline obs + 2 drops. Old denominator (cohort
    // only) would have computed 2/(6+2)=25%; new denominator uses
    // validObservationCount=10, giving 2/(10+2)≈17% — still acceptable.
    const result = buildDrift({
      agents: 2,
      obsPerAgent: 3,
      score: 0.92,
      baseline: 4,
      drops: 2,
    });
    expect(suggestAction(result, 5).kind).toBe("new-artifact");
  });
});

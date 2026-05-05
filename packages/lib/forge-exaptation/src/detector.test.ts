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
    artifactId: "artifact-1",
    scope: "default",
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
    artifactId: "artifact-1",
    scope: "default",
    agentId,
    divergenceScore,
    contextText: contextText ?? `ctx-${agentId}-${String(obsClock)}`,
    observedAt: obsClock,
  };
}

/**
 * Build a single observation window known to produce strong drift
 * (avgDivergence ≥ 0.85, replay-protected, 4 cohort agents). Use as a
 * "prior window" in suggestAction tests that want stability satisfied.
 *
 * Observations are dated in the deep past (negative `observedAt`) so the
 * window is always older than any current observation built via
 * `obs()` / `buildDrift()` afterwards — `countStrongDriftPriors`
 * requires priors to be strictly older than the current window.
 */
let priorClock = -1_000_000;
function strongPriorWindow(): readonly UsagePurposeObservation[] {
  const out: UsagePurposeObservation[] = [];
  for (const agent of ["prior-a", "prior-b", "prior-c", "prior-d"]) {
    for (const score of [0.95, 0.95, 0.95]) {
      const o = obs(agent, score);
      out.push({ ...o, observedAt: priorClock });
      priorClock++;
    }
  }
  // Leave a gap so successive priors never collide with each other.
  priorClock += 16;
  return out;
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
 * Build crafted observations + the corresponding `detectDrift` result.
 *
 * Tests assert on `result.*` (telemetry) and pass `observations` to
 * `suggestAction` (action path). `suggestAction` recomputes detection
 * internally — the action verdict is always grounded in observations,
 * not a caller-supplied DetectionResult, so spoofed/cloned/mutated
 * results cannot drive action recommendations.
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
}): {
  readonly observations: readonly UsagePurposeObservation[];
  readonly result: DetectionResult;
} {
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
  return { observations: list, result: detectDrift(list, DEFAULT_EXAPTATION_THRESHOLDS) };
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
  test("empty observations → no suggestion", () => {
    expect(suggestAction([], DEFAULT_EXAPTATION_THRESHOLDS, [])).toEqual({ kind: "none" });
  });

  test("observations producing no-drift → no suggestion", () => {
    expect(
      suggestAction([obs("a", 0.95), obs("b", 0.95)], DEFAULT_EXAPTATION_THRESHOLDS, []),
    ).toEqual({ kind: "none" });
  });

  test("invalid thresholds → no suggestion", () => {
    expect(suggestAction([], { ...DEFAULT_EXAPTATION_THRESHOLDS, minObservations: 0 }, [])).toEqual(
      { kind: "none" },
    );
  });

  test("borderline drift → reclassify (not new-artifact, even when stable priors exist)", () => {
    // avgDivergence=0.75 < 0.85 fork threshold — stays reclassify even with
    // a stable strong-drift prior, because the current window itself is below
    // the fork bar.
    const { observations } = buildDrift({ agents: 2, obsPerAgent: 3, score: 0.75 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind,
    ).toBe("reclassify");
  });

  test("strong current + strong prior → new-artifact", () => {
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92 });
    const action = suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [
      strongPriorWindow(),
    ]);
    expect(action.kind).toBe("new-artifact");
  });

  test("strong drift but no prior windows (single window) → reclassify", () => {
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, []).kind).toBe("reclassify");
  });

  test("regression: minimum-threshold drift cannot escalate to new-artifact via volume", () => {
    // avgDivergence at the detection floor (0.7), saturating severity by
    // volume — must NOT escalate to new-artifact even with stable strong priors.
    const { observations } = buildDrift({ agents: 8, obsPerAgent: 6, score: 0.7 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [
        strongPriorWindow(),
        strongPriorWindow(),
      ]).kind,
    ).toBe("reclassify");
  });

  test("real drift observations → new-artifact when stable+strong", () => {
    const { observations } = buildDrift({ agents: 3, obsPerAgent: 3, score: 0.92 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind,
    ).toBe("new-artifact");
  });

  test("trust-boundary: spoofed stable counter cannot unlock new-artifact", () => {
    // Earlier rounds accepted `stableWindows: number`. A buggy caller could
    // pass `99` to a fresh window with no prior evidence and trigger fork.
    // The new API takes raw prior windows, so empty current obs + empty
    // priors → no detection state can satisfy stability.
    expect(suggestAction([], DEFAULT_EXAPTATION_THRESHOLDS, [])).toEqual({ kind: "none" });
  });

  test("trust-boundary: priorWindows that don't actually contain drift do NOT count as stable", () => {
    // A caller passing weak / non-drifting prior windows must not unlock
    // new-artifact even when current window is strong.
    const weakPrior: UsagePurposeObservation[] = [
      ...[0.05, 0.05, 0.05].map((s) => obs("noisy-a", s)),
      ...[0.05, 0.05, 0.05].map((s) => obs("noisy-b", s)),
    ];
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [weakPrior]).kind).toBe(
      "reclassify",
    );
  });

  test("low-quality prior window (>25% conflicts) does NOT count toward stability", () => {
    // A prior window the package itself would refuse to act on must not be
    // accepted as stability evidence for a fresh strong current window.
    // Otherwise the action gate could be bypassed by laundering noisy
    // history through the stability path.
    const conflictHeavyPrior: UsagePurposeObservation[] = [];
    for (let i = 0; i < 3; i++) {
      const eid = `pc-${String(i)}`;
      conflictHeavyPrior.push({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "victim",
        eventId: eid,
        divergenceScore: 0.4,
        contextText: "x",
        observedAt: i,
      });
      conflictHeavyPrior.push({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "victim",
        eventId: eid,
        divergenceScore: 0.95,
        contextText: "x",
        observedAt: i,
      });
    }
    conflictHeavyPrior.push(...[0.95, 0.95, 0.95].map((s) => obs("good-a", s)));
    conflictHeavyPrior.push(...[0.95, 0.95, 0.95].map((s) => obs("good-b", s)));
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [conflictHeavyPrior]).kind,
    ).toBe("reclassify");
  });

  test("priorWindows recency derived from observedAt, not caller-supplied array order", () => {
    // Trust-boundary: a buggy or malicious caller must not be able to flip
    // the verdict by shuffling priorWindows. Recency comes from each
    // window's max observedAt — the same observations laid down on the
    // wire — so any permutation of the same windows produces the same
    // verdict.
    //
    // Here `strong` is built first (lower timestamps) and `weak` second
    // (higher timestamps), so the **observed** trailing window is `weak`.
    // Both array orderings must therefore land on `reclassify` (weak
    // trailing → run length 0). Earlier code trusted array position and
    // would have promoted `[weak, strong]` to `new-artifact` — which is
    // exactly the spoofing path we close.
    const strong = strongPriorWindow();
    const weak: UsagePurposeObservation[] = [
      ...[0.05, 0.05, 0.05].map((s) => obs("noisy-a", s)),
      ...[0.05, 0.05, 0.05].map((s) => obs("noisy-b", s)),
    ];
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strong, weak]).kind).toBe(
      "reclassify",
    );
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [weak, strong]).kind).toBe(
      "reclassify",
    );
  });

  test("invalid observations cannot influence prior-window recency ordering", () => {
    // Trust-boundary: an attacker (or buggy emitter) might attach a
    // far-future `observedAt` to an OTHERWISE-INVALID observation (missing
    // scope, blank agentId) and graft it into a stale strong-drift window
    // to make that window look like the most recent prior. If recency were
    // computed from raw observations the stale window would jump to the
    // trailing slot and unlock `new-artifact`. Recency must be derived
    // from the same validated samples the detector trusts, so this junk
    // timestamp has zero influence.
    const staleStrongWithJunkFutureStamp: UsagePurposeObservation[] = [
      ...strongPriorWindow(),
      // Junk: blank agentId makes the observation invalid; the future
      // timestamp must NOT be used for recency. (scope: "" is now
      // legitimate compat-path data, so we use the still-required
      // agentId field to force an invalid sample.)
      {
        artifactId: "artifact-1",
        scope: "tenant-X",
        agentId: "",
        divergenceScore: 0.99,
        contextText: "junk",
        observedAt: Number.MAX_SAFE_INTEGER,
        eventId: "junk",
      },
    ];
    // Build a genuinely-recent weak window AFTER (so its timestamps are
    // higher than the strong window's real samples).
    const trulyRecentWeak: UsagePurposeObservation[] = [
      ...[0.05, 0.05, 0.05].map((s) => obs("noisy-late-a", s)),
      ...[0.05, 0.05, 0.05].map((s) => obs("noisy-late-b", s)),
    ];
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    // Without the validity filter, the junk MAX_SAFE_INTEGER stamp would
    // sort the stale strong window into the trailing slot → new-artifact.
    // With the filter, the trulyRecentWeak window is correctly trailing →
    // reclassify (run length 0).
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [
        staleStrongWithJunkFutureStamp,
        trulyRecentWeak,
      ]).kind,
    ).toBe("reclassify");
    // Same result regardless of array order — recency is observation-derived.
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [
        trulyRecentWeak,
        staleStrongWithJunkFutureStamp,
      ]).kind,
    ).toBe("reclassify");
  });

  test("current window passed as a prior does not count as its own stability evidence (identity)", () => {
    // Trust-boundary: a sliding-window bookkeeping bug that includes the
    // current observations array in priorWindows must NOT unlock
    // new-artifact on the very first detection. Identity check catches
    // the typical case (same array reference reused).
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [observations]).kind).toBe(
      "reclassify",
    );
  });

  test("current window cloned into priorWindows still does not count (content signature)", () => {
    // Same threat, harder version: caller deep-clones the array (e.g. via
    // spread or slice) so identity check misses. A content signature over
    // validated observations catches it — the cloned window has the same
    // canonical signature as the current window.
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    const cloned: readonly UsagePurposeObservation[] = [...observations];
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [cloned]).kind).toBe(
      "reclassify",
    );
  });

  test("undated prior windows fail stability outright (cannot be silently skipped)", () => {
    // If a prior window's max observedAt is non-finite, we cannot know
    // whether it is the most-recent prior. Skipping it would let an
    // older strong window unlock new-artifact during degraded telemetry.
    // The safe behavior: any undated prior fails stability entirely.
    const undatedStrong: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-a",
        divergenceScore: s,
        contextText: `u-a-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-a-${String(i)}`,
      })),
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-b",
        divergenceScore: s,
        contextText: `u-b-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-b-${String(i)}`,
      })),
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-c",
        divergenceScore: s,
        contextText: `u-c-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-c-${String(i)}`,
      })),
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-d",
        divergenceScore: s,
        contextText: `u-d-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-d-${String(i)}`,
      })),
    ];
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    // Even one undated prior alongside a strong dated prior must fail
    // stability — we can't trust the ordering.
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [
        strongPriorWindow(),
        undatedStrong,
      ]).kind,
    ).toBe("reclassify");
  });

  test("explicit __legacy__ scope is rejected at validation (sentinel reserved)", () => {
    // The LEGACY_SCOPE sentinel is internal — a real tenant happening to
    // use that string must NOT collide with the missing-scope compat
    // bucket. isObservationValid drops observations whose explicit scope
    // is "__legacy__" so the sentinel cannot be forged from outside.
    const observations: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("a", s), scope: "__legacy__" })),
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("b", s), scope: "  __legacy__  " })),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    // All 6 observations dropped at validation → invalid-config.
    expect(result.kind).toBe("invalid-config");
    if (result.kind === "invalid-config") expect(result.reason).toContain("6");
  });

  test("timestamp-skewed clone of the current window cannot pose as a prior", () => {
    // Trust-boundary: a caller that clones the current window and shifts
    // every observedAt slightly earlier must NOT slip past the
    // self-reference check. windowSignature now excludes observedAt and
    // the prior-overlap check rejects ANY shared (validated) observation
    // identity — so a timestamp-skewed self-clone shares all identities
    // and is filtered out before stability counting.
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    const cloneShifted: UsagePurposeObservation[] = observations.map((o, i) => ({
      ...o,
      observedAt: -10_000_000 - i, // far older than current
    }));
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [cloneShifted]).kind).toBe(
      "reclassify",
    );
  });

  test("prior windows from a different artifactId do not count toward stability", () => {
    // Trust-boundary: a routing bug or multi-artifact buffer mixup that
    // hands suggestAction a strong prior from a DIFFERENT artifact must
    // NOT unlock new-artifact for the current artifact. The detector
    // matches priors against the current window's artifactId set.
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    function pinAt(o: UsagePurposeObservation, at: number): UsagePurposeObservation {
      return { ...o, observedAt: at };
    }
    const otherArtifactStrongPrior: UsagePurposeObservation[] = strongPriorWindow().map((o) =>
      pinAt({ ...o, artifactId: "different-artifact" }, -8_000_000),
    );
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [otherArtifactStrongPrior]).kind,
    ).toBe("reclassify");
  });

  test("missing artifactId is rejected at validation", () => {
    // L0 contract: artifactId is required. Observations without it
    // cannot attribute drift to an artifact and must drop.
    const observations: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => {
        const o = obs("a", s);
        const { artifactId: _id, ...rest } = o;
        return rest as UsagePurposeObservation;
      }),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("invalid-config");
  });

  test("priors newer than (or equal to) the current window are excluded from stability", () => {
    // Trust-boundary: a "prior" with timestamps >= current window cannot
    // be historical evidence — it is either the same window misfiled or
    // a future window from a multi-buffer mixup. countStrongDriftPriors
    // requires priors to be strictly older. Otherwise a sliding-window
    // bookkeeping bug could let a same-time or future strong window
    // satisfy stability and unlock new-artifact prematurely.
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    // Build a "prior" that is actually NEWER than the current window.
    function pinAt(o: UsagePurposeObservation, at: number): UsagePurposeObservation {
      return { ...o, observedAt: at };
    }
    const newerStrong: UsagePurposeObservation[] = strongPriorWindow().map((o) =>
      pinAt(o, 9_999_999_999),
    );
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [newerStrong]).kind).toBe(
      "reclassify",
    );
  });

  test("same-eventId replay with bumped observedAt cannot forge prior recency", () => {
    // Trust-boundary: dedup collapses same-(scope,agentId,eventId) retries
    // with identical payloads as harmless replays — but if recency were
    // computed from the raw observations, a replay with a fresh
    // observedAt could still raise the prior's maxAt and slot a stale
    // window into the trailing position. Recency must come from the
    // canonical (MIN-observedAt) representative per dedup bucket.
    function pinAt(o: UsagePurposeObservation, at: number): UsagePurposeObservation {
      return { ...o, observedAt: at };
    }
    // Build a strong prior anchored at an ancient timestamp.
    const ancient = -5_000_000;
    const stalePrior: UsagePurposeObservation[] = strongPriorWindow().map((o) => pinAt(o, ancient));
    // Replay one of those exact observations with a much newer
    // observedAt — same (scope, agentId, eventId), same payload.
    const first = stalePrior[0];
    if (first === undefined) throw new Error("test setup");
    const bumpedReplay: UsagePurposeObservation = pinAt(first, 9_999_999_999);
    const stalePriorWithReplay: readonly UsagePurposeObservation[] = [...stalePrior, bumpedReplay];
    // Build a weak prior that legitimately sits between the ancient
    // strong window and the current window.
    const weakRecent: UsagePurposeObservation[] = [0.05, 0.05, 0.05]
      .flatMap((s) => [obs("noisy-a", s), obs("noisy-b", s)])
      .map((o) => pinAt(o, -1_000_000));
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    // If the replay-bumped observedAt drove recency, the stale window
    // would slot into the trailing position past `weakRecent` and
    // unlock new-artifact. With dedup-aware recency, the stale window
    // stays at -5_000_000, weakRecent (-1_000_000) is trailing, and
    // the run is broken → reclassify.
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [stalePriorWithReplay, weakRecent])
        .kind,
    ).toBe("reclassify");
  });

  test("equal-recency priorWindows are evaluated as a tied group (caller order does not matter)", () => {
    // Trust-boundary: when two prior windows share the same max observedAt
    // (coarsened-to-the-second batches, same-frame producers), array order
    // must NOT decide the verdict. The detector treats tied windows
    // atomically: every window in the trailing tie group must clear the
    // strong-drift bar, otherwise the whole tied group breaks the run.
    const sharedTime = 100;
    function tieWindow(strong: boolean, agentPrefix: string): UsagePurposeObservation[] {
      const score = strong ? 0.95 : 0.05;
      return ["a", "b", "c", "d"].flatMap((suffix) =>
        [score, score, score].map((s, i) => ({
          artifactId: "artifact-1",
          scope: "default",
          agentId: `${agentPrefix}-${suffix}`,
          divergenceScore: s,
          contextText: `${agentPrefix}-${suffix}-${String(i)}`,
          observedAt: sharedTime,
          eventId: `${agentPrefix}-${suffix}-${String(i)}`,
        })),
      );
    }
    const tiedStrong = tieWindow(true, "tie-strong");
    const tiedWeak = tieWindow(false, "tie-weak");
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    // Both orderings must produce the same verdict — `reclassify`, because
    // the tied group contains a weak window that breaks the run.
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [tiedStrong, tiedWeak]).kind,
    ).toBe("reclassify");
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [tiedWeak, tiedStrong]).kind,
    ).toBe("reclassify");
  });

  test("legacy-scope cohort is denied action-bearing suggestions (rolling-migration safety)", () => {
    // During a rolling scope migration, observations missing scope all
    // bucket into LEGACY_SCOPE — possibly mixing tenants. detectDrift
    // still surfaces the signal (telemetry), but suggestAction must
    // refuse `reclassify` / `new-artifact` so cross-tenant evidence
    // cannot drive irreversible artifact rewrites or forks.
    function omitScope(o: UsagePurposeObservation): UsagePurposeObservation {
      const { scope: _scope, ...rest } = o;
      return rest;
    }
    const legacyObservations: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("legacy-a", s))),
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("legacy-b", s))),
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("legacy-c", s))),
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("legacy-d", s))),
    ];
    // detectDrift still reports drift (signal preserved for dashboards)
    // and exposes cohortHasLegacyScope so callers can branch.
    const result = detectDrift(legacyObservations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") expect(result.cohortHasLegacyScope).toBe(true);
    // suggestAction refuses action-bearing suggestions.
    expect(suggestAction(legacyObservations, DEFAULT_EXAPTATION_THRESHOLDS).kind).toBe("none");
    // Even with strong stable priors, action stays denied because the
    // *current* cohort itself is legacy-contaminated.
    expect(
      suggestAction(legacyObservations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind,
    ).toBe("none");
  });

  test("legacy-scope prior windows do not count toward stability", () => {
    // A prior window whose cohort is legacy-contaminated is itself unsafe
    // to act on, so it must not bump stability for a fresh strong current
    // window. Otherwise a caller could launder cross-tenant legacy
    // history through the priorWindows path to unlock `new-artifact`.
    function omitScope(o: UsagePurposeObservation): UsagePurposeObservation {
      const { scope: _scope, ...rest } = o;
      return rest;
    }
    const legacyStrongPrior: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("lp-a", s))),
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("lp-b", s))),
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("lp-c", s))),
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("lp-d", s))),
    ];
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [legacyStrongPrior]).kind,
    ).toBe("reclassify");
  });

  test("priorWindows with no finite observedAt cannot satisfy stability", () => {
    // Degraded telemetry: a prior window where every observation lacks a
    // usable observedAt sorts to the bottom (oldest) and breaks the
    // trailing-consecutive-run check before it can be counted. Otherwise
    // a caller could elide timestamps to avoid the recency check while
    // still claiming "stable" history.
    const undatedStrong: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-a",
        divergenceScore: s,
        contextText: `u-a-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-a-${String(i)}`,
      })),
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-b",
        divergenceScore: s,
        contextText: `u-b-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-b-${String(i)}`,
      })),
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-c",
        divergenceScore: s,
        contextText: `u-c-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-c-${String(i)}`,
      })),
      ...[0.95, 0.95, 0.95].map((s, i) => ({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "u-d",
        divergenceScore: s,
        contextText: `u-d-${String(i)}`,
        observedAt: Number.NaN,
        eventId: `u-d-${String(i)}`,
      })),
    ];
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [undatedStrong]).kind).toBe(
      "reclassify",
    );
  });

  test("stability requires the trailing CONSECUTIVE run to be strong-drift", () => {
    // The trailing run starts at the prior with the highest observedAt.
    // A non-strong window in that trailing position breaks the run, so an
    // old outlier cannot satisfy stability for an unrelated current window.
    // Recency is timestamp-derived (NOT array-position-derived), and all
    // priors must be strictly older than the current window — so we
    // pin every observation's `observedAt` explicitly here.
    function pinAt<T extends UsagePurposeObservation>(o: T, at: number): T {
      return { ...o, observedAt: at };
    }
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.95 });
    const strongAtT1: UsagePurposeObservation[] = strongPriorWindow().map((o) =>
      pinAt(o, -3_000_000),
    );
    const strongAtT2: UsagePurposeObservation[] = strongPriorWindow().map((o) =>
      pinAt(o, -2_000_000),
    );
    const weakAtT1: UsagePurposeObservation[] = [0.05, 0.05, 0.05]
      .flatMap((s) => [obs("noisy-a", s), obs("noisy-b", s)])
      .map((o) => pinAt(o, -3_000_000));
    const weakAtT2: UsagePurposeObservation[] = [0.05, 0.05, 0.05]
      .flatMap((s) => [obs("noisy-c", s), obs("noisy-d", s)])
      .map((o) => pinAt(o, -2_000_000));

    // Case 1: trailing prior is weak → run length 0 → reclassify.
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongAtT1, weakAtT2]).kind,
    ).toBe("reclassify");
    // Case 2: trailing prior is strong → run length 1 → new-artifact.
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [weakAtT1, strongAtT2]).kind,
    ).toBe("new-artifact");
  });
});

describe("suggestAction replay-protection gate", () => {
  test("any observation without eventId → none", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obsNoId("a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obsNoId("b", s)),
    ];
    expect(suggestAction(obsList, DEFAULT_EXAPTATION_THRESHOLDS, [])).toEqual({
      kind: "none",
    });
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
      artifactId: "artifact-1",
      scope: "default",
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
      artifactId: "artifact-1",
      scope: "default",
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
  test("low-quality drift (>25% dropped) → none", () => {
    // 12 valid (4 agents × 3 obs at 0.92) + 5 dropped → 5/17 ≈ 29% > 25%.
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92, drops: 5 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]),
    ).toEqual({ kind: "none" });
  });

  test("acceptable-quality drift (<=25% dropped) → action", () => {
    // 12 valid + 2 dropped → 2/14 ≈ 14% < 25%.
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92, drops: 2 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind,
    ).toBe("new-artifact");
  });

  test("low-quality drift (>25% duplicates) → none", () => {
    // 12 valid + 10 same-eventId duplicates that collapse → 10/22 ≈ 45% > 25%.
    const { observations, result } = buildDrift({
      agents: 4,
      obsPerAgent: 3,
      score: 0.92,
      dups: 10,
    });
    if (result.kind === "drift") expect(result.duplicateCount).toBeGreaterThan(0);
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]),
    ).toEqual({ kind: "none" });
  });

  test("clean drift with no drops/dups passes quality gate", () => {
    const { observations } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.92 });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind,
    ).toBe("new-artifact");
  });
});

describe("partial-eventId dedup + cohort-scoped replay protection", () => {
  test("baseline obs without eventId outside the cohort does NOT disable replay protection", () => {
    // Cohort all replay-protected; one no-eventId baseline below threshold.
    // Cohort-scoped replayProtected stays true (the no-eventId obs is NOT
    // in the cohort). The quality gate counts the missing-eventId obs as
    // low-quality, but at < 25% it doesn't block action.
    const observations: UsagePurposeObservation[] = [
      ...Array.from({ length: 6 }, () => obs("a1", 0.95)),
      ...Array.from({ length: 6 }, () => obs("a2", 0.95)),
      // 1 baseline no-eventId in 13 valid total → missing/total = 1/13 ≈ 7.7%.
      obsNoId("a3", 0.05),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.replayProtected).toBe(true);
      expect(result.missingEventIdCount).toBe(1);
    }
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind,
    ).toBe("new-artifact");
  });

  test("partial telemetry outage (>25% missing eventId) blocks action even when cohort is clean", () => {
    // Cohort itself is replay-protected, but more than 25% of valid window
    // observations bypassed dedup. The quality gate now sees the partial
    // telemetry failure and refuses action — closing the path where a
    // cohort-scoped flag could hide a wide outage outside the cohort.
    const observations: UsagePurposeObservation[] = [
      ...Array.from({ length: 6 }, () => obs("a1", 0.95)),
      ...Array.from({ length: 6 }, () => obs("a2", 0.95)),
      // 6 baseline no-eventId in 18 valid total → 6/18 = 33% > 25%.
      ...Array.from({ length: 6 }, (_, i) => obsNoId(`baseline-${String(i)}`, 0.05)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.replayProtected).toBe(true);
      expect(result.missingEventIdCount).toBe(6);
    }
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]),
    ).toEqual({ kind: "none" });
  });

  test("cohort observation missing eventId DOES disable replay protection", () => {
    // 3 a1 with eventId + 3 a2 without eventId (BOTH at 0.95, both in cohort).
    // Cohort contains an obs that bypassed dedup → replay-unsafe.
    const observations: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obs("a1", s)),
      ...[0.95, 0.95, 0.95].map((s) => obsNoId("a2", s)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.replayProtected).toBe(false);
    }
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [])).toEqual({
      kind: "none",
    });
  });
});

describe("non-finite observedAt dedup tiebreak", () => {
  test("equal-score duplicates with NaN observedAt fall through to contextText (order-independent)", () => {
    const eid = "shared";
    const a: UsagePurposeObservation = {
      artifactId: "artifact-1",
      scope: "default",
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
  test("nested report fields on detectDrift output are frozen", () => {
    // Without deep freeze, telemetry consumers could mutate `result.report`
    // before logging or persisting it, producing inconsistent observability.
    const { result } = buildDrift({ agents: 4, obsPerAgent: 3, score: 0.75 });
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(() => {
        (result.report as { avgDivergence: number }).avgDivergence = 0.99;
      }).toThrow();
      expect(() => {
        (result.report as { severity: number }).severity = 1;
      }).toThrow();
      expect(result.report.avgDivergence).toBeLessThan(0.85);
    }
  });
});

describe("dedup conflict quarantine", () => {
  test("conflicting (scope, agentId, eventId) retries with different payloads quarantine the bucket", () => {
    // Two retries on the same key with different divergenceScore is a sign
    // of a corrupted replay. Earlier rounds picked the max-divergence sample
    // as the deterministic winner, but that systematically biases the system
    // toward the most alarming payload — one corrupted retry could push a
    // benign observation into drift territory. The detector now refuses to
    // pick a winner: every observation that touched the bucket counts in
    // `conflictCount`, none flow through to cohort scoring, and the quality
    // gate folds the count into its low-quality denominator.
    const sharedEid = "evt-shared";
    const lo: UsagePurposeObservation = {
      artifactId: "artifact-1",
      scope: "default",
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
    const ordered = [lo, hi, ...otherAgents];
    const reverseOrdered = [hi, lo, ...otherAgents];
    const r1 = detectDrift(ordered, DEFAULT_EXAPTATION_THRESHOLDS);
    const r2 = detectDrift(reverseOrdered, DEFAULT_EXAPTATION_THRESHOLDS);
    // Outcome is identical regardless of arrival order: the conflicting bucket
    // is quarantined either way.
    expect(r1.kind).toBe(r2.kind);
    if (r1.kind === "drift" && r2.kind === "drift") {
      expect(r1.conflictCount).toBe(2);
      expect(r2.conflictCount).toBe(2);
      // a1's evidence is gone; only a2 + a3 remain in cohort.
      expect(r1.report.divergentAgents).toBe(2);
      expect(r1.report.observationCount).toBe(6);
    }
  });

  test("retry with internal-whitespace skew (rolling deploy serializer) does NOT quarantine", () => {
    // Rolling deploys can change internal whitespace (single space vs double
    // space, tab vs space, newline injection) without changing the meaning
    // of the model context. Compare normalized text so these collapse as
    // duplicates rather than quarantining the bucket.
    const eid = "evt-ws";
    const a: UsagePurposeObservation = {
      artifactId: "artifact-1",
      scope: "default",
      agentId: "a1",
      eventId: eid,
      divergenceScore: 0.95,
      contextText: "read configuration files",
      observedAt: 1,
    };
    const b: UsagePurposeObservation = { ...a, contextText: "read  configuration\tfiles" };
    const c: UsagePurposeObservation = { ...a, contextText: "read\nconfiguration  files" };
    const observations: UsagePurposeObservation[] = [
      a,
      b,
      c,
      ...[0.95, 0.95, 0.95].map((s) => obs("a2", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("a3", s)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift") {
      expect(result.duplicateCount).toBe(2);
      expect(result.conflictCount).toBe(0);
    }
  });

  test("retry skew within tolerance does NOT trigger quarantine (legitimate retry)", () => {
    // Rolling deploys / float drift can produce harmless variation: scores
    // differ in the 5th decimal, contextText gains/loses surrounding
    // whitespace. The detector normalizes both before equality, so these
    // collapse as duplicates — not as conflicts that erase evidence.
    const eid = "evt-skew";
    const original: UsagePurposeObservation = {
      artifactId: "artifact-1",
      scope: "default",
      agentId: "a1",
      eventId: eid,
      divergenceScore: 0.95,
      contextText: "read configuration files",
      observedAt: 1,
    };
    const skewed: UsagePurposeObservation = {
      ...original,
      divergenceScore: 0.94999999, // float drift below precision boundary
      contextText: "  read configuration files\n", // whitespace edit
      observedAt: 2,
    };
    const observations: UsagePurposeObservation[] = [
      original,
      skewed,
      ...[0.95, 0.95, 0.95].map((s) => obs("a2", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("a3", s)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      // Skew collapsed as duplicate, not quarantined as conflict.
      expect(result.duplicateCount).toBe(1);
      expect(result.conflictCount).toBe(0);
    }
  });

  test("genuine score divergence beyond precision DOES trigger quarantine", () => {
    // Score difference of 0.55 is far beyond rounding noise — that's a real
    // payload disagreement, treated as a conflict.
    const eid = "evt-real-conflict";
    const lo: UsagePurposeObservation = {
      artifactId: "artifact-1",
      scope: "default",
      agentId: "a1",
      eventId: eid,
      divergenceScore: 0.4,
      contextText: "x",
      observedAt: 1,
    };
    const hi: UsagePurposeObservation = { ...lo, divergenceScore: 0.95 };
    const observations: UsagePurposeObservation[] = [
      lo,
      hi,
      ...[0.95, 0.95, 0.95].map((s) => obs("a2", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("a3", s)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift") {
      expect(result.conflictCount).toBe(2);
      expect(result.duplicateCount).toBe(0);
    }
  });

  test("identical-payload retries still collapse as duplicates (replay protection)", () => {
    // Replay of the same logical event with same payload — the desired and
    // safe collapse. duplicateCount tracks these; conflictCount stays 0.
    const seed = obs("a1", 0.95);
    const observations: UsagePurposeObservation[] = [
      seed,
      seed,
      seed,
      ...[0.95, 0.95, 0.95].map((s) => obs("a2", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("a3", s)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    if (result.kind === "drift") {
      expect(result.duplicateCount).toBe(2);
      expect(result.conflictCount).toBe(0);
    }
  });

  test("conflict above 25% blocks action-bearing suggestions (quality gate)", () => {
    // A corrupted-replay attack tries to inject a high-divergence retry to
    // tip the bucket. The quality gate now counts conflictCount as
    // low-quality and refuses action-bearing recommendations.
    const conflicts: UsagePurposeObservation[] = [];
    // 4 conflicting buckets × 2 obs each = 8 quarantined observations
    for (let i = 0; i < 4; i++) {
      const eid = `conflict-${String(i)}`;
      conflicts.push({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "victim",
        eventId: eid,
        divergenceScore: 0.4,
        contextText: "benign",
        observedAt: i,
      });
      conflicts.push({
        artifactId: "artifact-1",
        scope: "default",
        agentId: "victim",
        eventId: eid,
        divergenceScore: 0.95,
        contextText: "benign",
        observedAt: i,
      });
    }
    const goodCohort: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obs("good-a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("good-b", s)),
    ];
    const observations = [...conflicts, ...goodCohort];
    // 8 conflict + 6 valid = 14 total; 8/14 ≈ 57% > 25%.
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]),
    ).toEqual({ kind: "none" });
  });
});

describe("tenant isolation via required scope field", () => {
  test("same agentId in two tenant scopes counts as two cohort members", () => {
    // Same logical agent in two tenants is two distinct observers — `(scope,
    // agentId)` cohort key keeps them as independent evidence.
    const observations: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("agent-shared", s), scope: "tenant-A" })),
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("agent-shared", s), scope: "tenant-B" })),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.report.observationCount).toBe(6);
      expect(result.report.divergentAgents).toBe(2);
    }
  });

  test("missing/blank scope normalizes to __legacy__ sentinel (backward compat)", () => {
    // Compat path for pre-multi-tenant emitters: missing or whitespace-only
    // scope normalizes to a single named sentinel rather than dropping the
    // observation outright. The sentinel is observable (it shows up
    // explicitly in cohort keys), so deployments can grep / alert and
    // migrate emitters off of it. Crucially there is still NO implicit
    // global namespace — `__legacy__` is itself a scope, so two tenants
    // with real scopes stay isolated from each other and from legacy
    // traffic.
    function omitScope(o: UsagePurposeObservation): UsagePurposeObservation {
      const { scope: _scope, ...rest } = o;
      return rest;
    }
    const observations: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("a", s))),
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("b", s), scope: "" })),
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("c", s), scope: "  " })),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      // All three legacy-scope agents bucket into __legacy__ and
      // contribute to the cohort.
      expect(result.report.divergentAgents).toBe(3);
      expect(result.droppedCount).toBe(0);
    }
  });

  test("legacy-scope traffic does NOT bleed into tenants with real scope", () => {
    // The __legacy__ sentinel is itself a scope, so observations missing
    // scope share a bucket with each other but stay isolated from
    // tenants that DO set scope. Otherwise the compat path would
    // re-introduce the silent multi-tenant merge it was meant to avoid.
    function omitScope(o: UsagePurposeObservation): UsagePurposeObservation {
      const { scope: _scope, ...rest } = o;
      return rest;
    }
    const observations: UsagePurposeObservation[] = [
      // Same agentId in legacy + a real tenant — must count as 2
      // independent cohort members.
      ...[0.95, 0.95, 0.95].map((s) => omitScope(obs("shared", s))),
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("shared", s), scope: "tenant-X" })),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      expect(result.report.divergentAgents).toBe(2);
    }
  });

  test("retries within a single (scope, agentId) collapse via dedup", () => {
    const eid = "evt-1";
    const observations: UsagePurposeObservation[] = [
      {
        artifactId: "artifact-1",
        scope: "tenant-A",
        agentId: "a",
        eventId: eid,
        divergenceScore: 0.95,
        observedAt: 1,
        contextText: "x",
      },
      {
        artifactId: "artifact-1",
        scope: "tenant-A",
        agentId: "a",
        eventId: eid,
        divergenceScore: 0.95,
        observedAt: 2,
        contextText: "x",
      },
      {
        artifactId: "artifact-1",
        scope: "tenant-A",
        agentId: "a",
        eventId: eid,
        divergenceScore: 0.95,
        observedAt: 3,
        contextText: "x",
      },
      ...[0.95, 0.95, 0.95].map((s) => obs("b", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("c", s)),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") {
      // a collapses 3 → 1 (fails minObsPerAgent so excluded). b + c contribute.
      expect(result.report.observationCount).toBe(6);
      expect(result.duplicateCount).toBe(2);
    }
  });
});

describe("agentId normalization", () => {
  test("whitespace-only agentId is dropped (cannot fake multi-agent diversity)", () => {
    const observations: UsagePurposeObservation[] = [
      ...Array.from({ length: 4 }, () => ({ ...obs(" ", 0.95), agentId: " " })),
      ...Array.from({ length: 4 }, () => ({ ...obs("\n", 0.95), agentId: "\n" })),
      ...Array.from({ length: 4 }, () => ({ ...obs("\t", 0.95), agentId: "\t" })),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    // All observations dropped → invalid-config (degraded telemetry).
    expect(result.kind).toBe("invalid-config");
    if (result.kind === "invalid-config") expect(result.reason).toContain("12");
  });

  test("agentIds varying only in surrounding whitespace bucket as one agent", () => {
    // Without trim normalization, "agent-a" and "agent-a " would count as
    // distinct agents and could falsely satisfy minDivergentAgents.
    const observations: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("agent-a", s), agentId: "agent-a" })),
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("agent-a", s), agentId: "agent-a " })),
      ...[0.95, 0.95, 0.95].map((s) => ({ ...obs("agent-a", s), agentId: " agent-a\n" })),
    ];
    const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    // Only one true agent → fails minDivergentAgents=2.
    expect(result.kind).toBe("no-drift");
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
    expect(suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [])).toEqual({
      kind: "none",
    });
  });

  test("eventIds varying only in surrounding whitespace still collapse", () => {
    // Upstream emitter sometimes pads keys; trim makes "foo" and "foo " the
    // same dedup bucket so retries still collapse.
    const make = (eventId: string, observedAt: number): UsagePurposeObservation => ({
      artifactId: "artifact-1",
      scope: "default",
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

  test("accidental cross-tenant (agentId, eventId) collision keeps observations independent (scoped dedup)", () => {
    // Two tenants happen to mint the same agentId AND eventId strings.
    // Scoped dedup `(scope, agentId, eventId)` keeps their evidence independent
    // rather than collapsing them as duplicates. Without scope, real evidence
    // here would be silently erased.
    const collidingId = "happens-to-collide";
    const observations: UsagePurposeObservation[] = [
      // tenantA — 2 distinct (legitimate) eventIds, plus a colliding-id event.
      {
        artifactId: "artifact-1",
        scope: "tenantA",
        agentId: "agent-x",
        eventId: "evt-1",
        divergenceScore: 0.95,
        observedAt: 1,
        contextText: "x",
      },
      {
        artifactId: "artifact-1",
        scope: "tenantA",
        agentId: "agent-x",
        eventId: "evt-2",
        divergenceScore: 0.95,
        observedAt: 2,
        contextText: "x",
      },
      {
        artifactId: "artifact-1",
        scope: "tenantA",
        agentId: "agent-x",
        eventId: collidingId,
        divergenceScore: 0.95,
        observedAt: 3,
        contextText: "x",
      },
      // tenantB — same agentId AND same colliding eventId. Scope keeps
      // tenantB's evidence independent of tenantA's.
      {
        artifactId: "artifact-1",
        scope: "tenantB",
        agentId: "agent-x",
        eventId: "evt-1",
        divergenceScore: 0.95,
        observedAt: 4,
        contextText: "x",
      },
      {
        artifactId: "artifact-1",
        scope: "tenantB",
        agentId: "agent-x",
        eventId: "evt-2",
        divergenceScore: 0.95,
        observedAt: 5,
        contextText: "x",
      },
      {
        artifactId: "artifact-1",
        scope: "tenantB",
        agentId: "agent-x",
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
    expect(suggestAction(obsList, DEFAULT_EXAPTATION_THRESHOLDS, [])).toEqual({
      kind: "none",
    });
  });

  test("every-observation-has-eventId window unlocks actions", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obs("a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("b", s)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    if (result.kind === "drift") expect(result.replayProtected).toBe(true);
    expect(suggestAction(obsList, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind).toBe(
      "new-artifact",
    );
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
    expect(suggestAction(obsList, DEFAULT_EXAPTATION_THRESHOLDS, [])).toEqual({
      kind: "none",
    });
  });

  test("minority drift cohort + stable + strong → new-artifact (fork specialized variant)", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.95, 0.95, 0.95].map((s) => obs("a", s)),
      ...[0.95, 0.95, 0.95].map((s) => obs("b", s)),
      ...Array.from({ length: 14 }, () => obs("c", 0.05)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    expect(suggestAction(obsList, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind).toBe(
      "new-artifact",
    );
  });

  test("majority drift cohort → reclassify allowed", () => {
    const obsList: UsagePurposeObservation[] = [
      ...[0.75, 0.75, 0.75].map((s) => obs("a", s)),
      ...[0.75, 0.75, 0.75].map((s) => obs("b", s)),
      ...Array.from({ length: 4 }, () => obs("c", 0.05)),
    ];
    const result = detectDrift(obsList, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(result.kind).toBe("drift");
    expect(suggestAction(obsList, DEFAULT_EXAPTATION_THRESHOLDS, []).kind).toBe("reclassify");
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
    // All 3 dropped at validation → invalid-config (degraded telemetry).
    expect(result.kind).toBe("invalid-config");
    if (result.kind === "invalid-config") expect(result.reason).toContain("3");
  });

  test("non-string contextText is dropped (would crash conflict dedup with .trim())", () => {
    // Untyped upstream payloads (JSON-deserialized without runtime checks)
    // can ship contextText as null / number / undefined. Without explicit
    // validation, a duplicate-event replay would invoke .trim() on the
    // non-string and throw — taking the detector down on exactly the replay
    // path it is supposed to harden.
    const eid = "evt-shared";
    const malformed = {
      artifactId: "artifact-1",
      scope: "default",
      agentId: "a1",
      eventId: eid,
      divergenceScore: 0.95,
      contextText: null as unknown as string,
      observedAt: 1,
    } satisfies UsagePurposeObservation;
    const goodTwin: UsagePurposeObservation = {
      artifactId: "artifact-1",
      scope: "default",
      agentId: "a1",
      eventId: eid,
      divergenceScore: 0.95,
      contextText: "real text",
      observedAt: 2,
    };
    // Should NOT throw — malformed observation is dropped at validation, the
    // good twin alone passes through.
    const result = detectDrift(
      [malformed, goodTwin, ...[0.95, 0.95, 0.95].map((s) => obs("a2", s))],
      DEFAULT_EXAPTATION_THRESHOLDS,
    );
    if (result.kind === "drift" || result.kind === "no-drift") {
      expect(result.droppedCount).toBe(1);
    }
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
    const { observations } = buildDrift({
      agents: 2,
      obsPerAgent: 3,
      score: 0.92,
      baseline: 4,
      drops: 2,
    });
    expect(
      suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, [strongPriorWindow()]).kind,
    ).toBe("new-artifact");
  });
});

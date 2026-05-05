/**
 * Scenario / corner-case tests for @koi/forge-exaptation.
 *
 * Drives the detector across multi-window timelines and validates the
 * end-to-end verdict trajectory. Pure-function library — no LLM, no
 * agent loop. Each scenario builds a sequence of observation windows
 * with explicit `observedAt` and feeds them into `suggestAction` with a
 * growing `priorWindows` history.
 */

import { describe, expect, test } from "bun:test";
import type { UsagePurposeObservation } from "@koi/core";
import {
  DEFAULT_EXAPTATION_THRESHOLDS,
  type DetectionResult,
  detectDrift,
  type ExaptationSuggestion,
  suggestAction,
} from "../detector.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let nextEventId = 0;
function evt(): string {
  nextEventId += 1;
  return `e-${String(nextEventId)}`;
}

interface MakeOpts {
  readonly artifactId?: string;
  readonly scope?: string;
  readonly observedAt: number;
  readonly agentId: string;
  readonly score: number;
  readonly contextText?: string;
}

function make(opts: MakeOpts): UsagePurposeObservation {
  return {
    artifactId: opts.artifactId ?? "artifact-1",
    scope: opts.scope ?? "tenant-A",
    agentId: opts.agentId,
    eventId: evt(),
    divergenceScore: opts.score,
    contextText: opts.contextText ?? `ctx-${opts.agentId}`,
    observedAt: opts.observedAt,
  };
}

/**
 * Strong-drift cohort window at the given time with optional artifactId.
 * 4 agents × 3 observations × 0.95 — comfortably above all thresholds.
 */
function strongWindow(at: number, artifactId = "artifact-1"): UsagePurposeObservation[] {
  const out: UsagePurposeObservation[] = [];
  for (const agent of ["a", "b", "c", "d"]) {
    for (let i = 0; i < 3; i++) {
      out.push(make({ artifactId, observedAt: at + i, agentId: `agent-${agent}`, score: 0.95 }));
    }
  }
  return out;
}

/** Baseline window — no drift. */
function baselineWindow(at: number): UsagePurposeObservation[] {
  const out: UsagePurposeObservation[] = [];
  for (const agent of ["a", "b", "c"]) {
    for (let i = 0; i < 3; i++) {
      out.push(make({ observedAt: at + i, agentId: `agent-${agent}`, score: 0.05 }));
    }
  }
  return out;
}

/**
 * Run a sliding-window simulation: for each window, suggestAction is
 * called with the current window plus all prior windows as history.
 */
function runScenario(
  windows: readonly UsagePurposeObservation[][],
): readonly ExaptationSuggestion[] {
  return windows.map((w, i) =>
    suggestAction(w, DEFAULT_EXAPTATION_THRESHOLDS, windows.slice(0, i)),
  );
}

function shuffle<T>(arr: readonly T[]): T[] {
  // Deterministic Fisher-Yates with a seeded PRNG.
  const out = [...arr];
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    const other = out[j];
    if (tmp === undefined || other === undefined) continue;
    out[i] = other;
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sliding-window verdict trajectories
// ---------------------------------------------------------------------------

describe("verdict trajectories across rolling windows", () => {
  test("steady baseline → 1 drift spike → reclassify (no stability yet)", () => {
    const trajectory = runScenario([
      baselineWindow(0),
      baselineWindow(100),
      baselineWindow(200),
      strongWindow(300),
    ]);
    expect(trajectory.map((s) => s.kind)).toEqual(["none", "none", "none", "reclassify"]);
  });

  test("drift sustained ≥ 2 windows → reclassify, then new-artifact", () => {
    const trajectory = runScenario([baselineWindow(0), strongWindow(100), strongWindow(200)]);
    expect(trajectory.map((s) => s.kind)).toEqual(["none", "reclassify", "new-artifact"]);
  });

  test("drift then recovery → returns to none on baseline window", () => {
    const trajectory = runScenario([
      strongWindow(0),
      strongWindow(100),
      strongWindow(200),
      baselineWindow(300),
    ]);
    expect(trajectory.map((s) => s.kind)).toEqual([
      "reclassify",
      "new-artifact",
      "new-artifact",
      "none",
    ]);
  });

  test("five consecutive strong windows: stable new-artifact run", () => {
    const trajectory = runScenario([
      strongWindow(0),
      strongWindow(100),
      strongWindow(200),
      strongWindow(300),
      strongWindow(400),
    ]);
    expect(trajectory.map((s) => s.kind)).toEqual([
      "reclassify",
      "new-artifact",
      "new-artifact",
      "new-artifact",
      "new-artifact",
    ]);
  });

  test("mid-migration timeline: legacy → mixed → all-explicit", () => {
    function omitArtifact(o: UsagePurposeObservation): UsagePurposeObservation {
      const { artifactId: _id, ...rest } = o;
      return rest;
    }
    const allLegacy = strongWindow(0).map(omitArtifact);
    const mixed: UsagePurposeObservation[] = [
      ...strongWindow(100).slice(0, 6).map(omitArtifact),
      ...strongWindow(100).slice(6, 12),
    ];
    const allExplicit = strongWindow(200);
    const allExplicit2 = strongWindow(300);
    const trajectory = runScenario([allLegacy, mixed, allExplicit, allExplicit2]);
    // Legacy presence in the cohort blocks action while migration in progress.
    expect(trajectory[0]?.kind).toBe("none");
    expect(trajectory[1]?.kind).toBe("none");
    // Once all observations carry explicit artifactId, action unlocks.
    expect(trajectory[2]?.kind).toBe("reclassify");
    // Once the timeline is dominated by explicit-artifact strong drift
    // (and any prior strong-drift signal qualifies, since artifactId
    // legacy contamination is bounded to action-time gating), stability
    // accumulates and the verdict promotes to new-artifact.
    expect(trajectory[3]?.kind).toBe("new-artifact");
  });
});

// ---------------------------------------------------------------------------
// Order invariance (lightweight property-style)
// ---------------------------------------------------------------------------

describe("order invariance", () => {
  test("detectDrift verdict is invariant under shuffling observations within a window", () => {
    const w = strongWindow(0);
    const a = detectDrift(w, DEFAULT_EXAPTATION_THRESHOLDS);
    const b = detectDrift(shuffle(w), DEFAULT_EXAPTATION_THRESHOLDS);
    expect(a.kind).toBe(b.kind);
    if (a.kind === "drift" && b.kind === "drift") {
      expect(a.report.divergentAgents).toBe(b.report.divergentAgents);
      expect(a.report.observationCount).toBe(b.report.observationCount);
      expect(a.report.avgDivergence).toBe(b.report.avgDivergence);
    }
  });

  test("suggestAction verdict is invariant under permutation of priorWindows", () => {
    const current = strongWindow(1000);
    const p1 = strongWindow(100);
    const p2 = strongWindow(200);
    const p3 = strongWindow(300);
    const a = suggestAction(current, DEFAULT_EXAPTATION_THRESHOLDS, [p1, p2, p3]);
    const b = suggestAction(current, DEFAULT_EXAPTATION_THRESHOLDS, [p3, p1, p2]);
    const c = suggestAction(current, DEFAULT_EXAPTATION_THRESHOLDS, [p2, p3, p1]);
    expect(a.kind).toBe(b.kind);
    expect(b.kind).toBe(c.kind);
    expect(a.kind).toBe("new-artifact");
  });

  test("appending a same-eventId replay does not change cohort scoring", () => {
    const w = strongWindow(0);
    const replay = w[0];
    if (replay === undefined) throw new Error("test setup");
    const wWithReplay = [...w, { ...replay, observedAt: replay.observedAt + 1 }];
    const a = detectDrift(w, DEFAULT_EXAPTATION_THRESHOLDS);
    const b = detectDrift(wWithReplay, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(a.kind).toBe("drift");
    expect(b.kind).toBe("drift");
    if (a.kind === "drift" && b.kind === "drift") {
      expect(a.report.divergentAgents).toBe(b.report.divergentAgents);
      expect(a.report.observationCount).toBe(b.report.observationCount);
      // The replay was correctly counted as a duplicate.
      expect(b.duplicateCount).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Tied-recency success path
// ---------------------------------------------------------------------------

describe("tied-recency priors", () => {
  test("two priors at the same recency, both strong → both count as stability", () => {
    // Both priors at -1000, both strong. Earlier tests only proved that
    // ANY failure in a tied group breaks the run; this proves the
    // success branch: a tied group of strong priors all contribute.
    const tiedA = strongWindow(-1000, "artifact-1").map((o) => ({
      ...o,
      agentId: `tieA-${o.agentId}`,
    }));
    const tiedB = strongWindow(-1000, "artifact-1").map((o) => ({
      ...o,
      agentId: `tieB-${o.agentId}`,
    }));
    const current = strongWindow(0);
    expect(suggestAction(current, DEFAULT_EXAPTATION_THRESHOLDS, [tiedA, tiedB]).kind).toBe(
      "new-artifact",
    );
  });
});

// ---------------------------------------------------------------------------
// Per-tenant isolation
// ---------------------------------------------------------------------------

describe("per-tenant isolation in a single window", () => {
  test("two tenants each with their own cohort do NOT aggregate divergentAgents across scope", () => {
    // Tenant-A: 4 agents drifting strong.
    // Tenant-B: 4 agents drifting strong, with the SAME logical agentIds.
    // Cohort attribution keys on (scope, agentId) so each tenant counts
    // 4 cohort agents — for a window total of 8 reported agents.
    const observations: UsagePurposeObservation[] = [
      ...strongWindow(0).map((o) => ({ ...o, scope: "tenant-A" })),
      ...strongWindow(50).map((o) => ({ ...o, scope: "tenant-B" })),
    ];
    const r = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
    expect(r.kind).toBe("drift");
    if (r.kind === "drift") {
      // 4 + 4 = 8 distinct (scope, agentId) cohort members.
      expect(r.report.divergentAgents).toBe(8);
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary values
// ---------------------------------------------------------------------------

describe("numeric boundary values", () => {
  test("observedAt at MAX_SAFE_INTEGER and MIN_SAFE_INTEGER survive recency math", () => {
    // Build a strong prior at MIN_SAFE_INTEGER and a strong current at
    // MAX_SAFE_INTEGER. recency math must not overflow / lose precision.
    function pinAt(o: UsagePurposeObservation, at: number): UsagePurposeObservation {
      return { ...o, observedAt: at };
    }
    const farPrior = strongWindow(0).map((o) => pinAt(o, Number.MIN_SAFE_INTEGER));
    const farCurrent = strongWindow(0).map((o, i) =>
      pinAt({ ...o, agentId: `cur-${o.agentId}` }, Number.MAX_SAFE_INTEGER - i),
    );
    const verdict = suggestAction(farCurrent, DEFAULT_EXAPTATION_THRESHOLDS, [farPrior]).kind;
    expect(verdict).toBe("new-artifact");
  });

  test("scores at and below divergenceThreshold do not clear the gate; clearly above does", () => {
    // The cohort-average comparison is `< divergenceThreshold` (strict),
    // so equal-to-threshold passes the per-observation filter, but IEEE-
    // 754 summation of 0.7+0.7+... produces an average epsilon-below 0.7
    // ⇒ the cohort gate fails. Document and lock that behavior here so
    // future refactors that would silently flip the gate are caught.
    const allAt07: UsagePurposeObservation[] = [];
    for (const agent of ["a", "b"]) {
      for (let i = 0; i < 3; i++) {
        allAt07.push(make({ observedAt: i, agentId: `eq-${agent}`, score: 0.7 }));
      }
    }
    expect(detectDrift(allAt07, DEFAULT_EXAPTATION_THRESHOLDS).kind).toBe("no-drift");

    // 0.6999 → below threshold, every observation filtered out at the
    // per-obs gate ⇒ cohort empty ⇒ no-drift.
    const justBelow: UsagePurposeObservation[] = [];
    for (const agent of ["a", "b"]) {
      for (let i = 0; i < 3; i++) {
        justBelow.push(make({ observedAt: i, agentId: `below-${agent}`, score: 0.6999 }));
      }
    }
    expect(detectDrift(justBelow, DEFAULT_EXAPTATION_THRESHOLDS).kind).toBe("no-drift");

    // Clearly above threshold ⇒ drift, confirming the gate isn't broken.
    const above: UsagePurposeObservation[] = [];
    for (const agent of ["a", "b"]) {
      for (let i = 0; i < 3; i++) {
        above.push(make({ observedAt: i, agentId: `above-${agent}`, score: 0.7001 }));
      }
    }
    expect(detectDrift(above, DEFAULT_EXAPTATION_THRESHOLDS).kind).toBe("drift");
  });
});

// ---------------------------------------------------------------------------
// Empty / degenerate prior shapes
// ---------------------------------------------------------------------------

describe("empty and degenerate priorWindows", () => {
  test("empty priorWindows array → no stability, falls back to reclassify on strong window", () => {
    const result = suggestAction(strongWindow(0), DEFAULT_EXAPTATION_THRESHOLDS, []);
    expect(result.kind).toBe("reclassify");
  });

  test("priorWindows containing one empty window → no stability contribution", () => {
    const result = suggestAction(strongWindow(0), DEFAULT_EXAPTATION_THRESHOLDS, [[]]);
    expect(result.kind).toBe("reclassify");
  });

  test("priorWindows containing only undated observations → no stability contribution", () => {
    const undatedStrong: UsagePurposeObservation[] = strongWindow(0).map((o) => ({
      ...o,
      observedAt: Number.NaN,
    }));
    const result = suggestAction(strongWindow(100), DEFAULT_EXAPTATION_THRESHOLDS, [undatedStrong]);
    expect(result.kind).toBe("reclassify");
  });
});

// ---------------------------------------------------------------------------
// Integration via public surface
// ---------------------------------------------------------------------------

describe("public-surface consumer integration", () => {
  test("imports only from the package index can drive an end-to-end run", async () => {
    // Mimics how a real downstream consumer (e.g. @koi/forge-tools)
    // would use the package: only public exports, no internal paths.
    const pkg: typeof import("../index.js") = await import("../index.js");
    const window = strongWindow(0);
    const r: DetectionResult = pkg.detectDrift(window, pkg.DEFAULT_EXAPTATION_THRESHOLDS);
    expect(r.kind).toBe("drift");
    const action: ExaptationSuggestion = pkg.suggestAction(
      window,
      pkg.DEFAULT_EXAPTATION_THRESHOLDS,
    );
    expect(action.kind).toBe("reclassify");
    // tokenize / computeJaccardDistance are also part of the public surface.
    const tokens = pkg.tokenize("read configuration files");
    const dist = pkg.computeJaccardDistance(tokens, pkg.tokenize("write configuration files"));
    expect(Number.isFinite(dist)).toBe(true);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(1);
  });
});

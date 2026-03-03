/**
 * Tests for collusion detection functions — all 4 signal detectors.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core/ecs";
import { DEFAULT_COLLUSION_THRESHOLDS } from "./config.js";
import {
  computeCV,
  computeHHI,
  computeMean,
  computeStddev,
  detectAll,
  detectConcentration,
  detectSpecialization,
  detectSyncMove,
  detectVarianceCollapse,
} from "./detector.js";
import type { AgentObservation, CollusionThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObs(
  agent: string,
  round: number,
  toolCalls: Record<string, number>,
  resourceAccess: Record<string, number> = {},
  trustScores: Record<string, number> = {},
): AgentObservation {
  return {
    agentId: agentId(agent),
    round,
    timestamp: Date.now(),
    toolCallCounts: new Map(Object.entries(toolCalls)),
    resourceAccessCounts: new Map(Object.entries(resourceAccess)),
    trustScoreChanges: new Map(Object.entries(trustScores)),
  };
}

const THRESHOLDS: CollusionThresholds = DEFAULT_COLLUSION_THRESHOLDS;

// ---------------------------------------------------------------------------
// Math utilities
// ---------------------------------------------------------------------------

describe("computeMean", () => {
  test("empty array → 0", () => {
    expect(computeMean([])).toBe(0);
  });

  test("single value → that value", () => {
    expect(computeMean([42])).toBe(42);
  });

  test("multiple values → correct mean", () => {
    expect(computeMean([1, 2, 3, 4, 5])).toBe(3);
  });
});

describe("computeStddev", () => {
  test("empty array → 0", () => {
    expect(computeStddev([], 0)).toBe(0);
  });

  test("single value → 0", () => {
    expect(computeStddev([5], 5)).toBe(0);
  });

  test("uniform values → 0", () => {
    expect(computeStddev([3, 3, 3], 3)).toBe(0);
  });

  test("known values → correct stddev", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const mean = computeMean(values);
    const stddev = computeStddev(values, mean);
    expect(stddev).toBeCloseTo(2, 0); // Population stddev ≈ 2
  });
});

describe("computeCV", () => {
  test("empty array → 0", () => {
    expect(computeCV([])).toBe(0);
  });

  test("single value → 0", () => {
    expect(computeCV([5])).toBe(0);
  });

  test("all zeros → 0", () => {
    expect(computeCV([0, 0, 0])).toBe(0);
  });

  test("identical values → 0", () => {
    expect(computeCV([10, 10, 10])).toBe(0);
  });

  test("high variation → high CV", () => {
    const cv = computeCV([1, 100]);
    expect(cv).toBeGreaterThan(0.5);
  });
});

describe("computeHHI", () => {
  test("empty array → 0", () => {
    expect(computeHHI([])).toBe(0);
  });

  test("single agent → 1 (monopoly)", () => {
    expect(computeHHI([100])).toBe(1);
  });

  test("equal shares → 1/N", () => {
    const hhi = computeHHI([25, 25, 25, 25]);
    expect(hhi).toBeCloseTo(0.25);
  });

  test("all zeros → 0", () => {
    expect(computeHHI([0, 0, 0])).toBe(0);
  });

  test("concentrated → high HHI", () => {
    const hhi = computeHHI([90, 5, 3, 2]);
    expect(hhi).toBeGreaterThan(0.8);
  });

  test("perfect competition → low HHI", () => {
    const hhi = computeHHI([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(hhi).toBeCloseTo(0.1);
  });
});

// ---------------------------------------------------------------------------
// detectSyncMove
// ---------------------------------------------------------------------------

describe("detectSyncMove", () => {
  test("empty observations → null", () => {
    expect(detectSyncMove([], THRESHOLDS)).toBeNull();
  });

  test("single round → null (need 2 rounds)", () => {
    const obs = [
      makeObs("a1", 1, { read: 10 }),
      makeObs("a2", 1, { read: 10 }),
      makeObs("a3", 1, { read: 10 }),
    ];
    expect(detectSyncMove(obs, THRESHOLDS)).toBeNull();
  });

  test("normal variation (no sync) → null", () => {
    const obs = [
      makeObs("a1", 1, { read: 10 }),
      makeObs("a2", 1, { read: 10 }),
      makeObs("a3", 1, { read: 10 }),
      makeObs("a1", 2, { read: 11 }), // +10%
      makeObs("a2", 2, { read: 9 }), // -10%
      makeObs("a3", 2, { read: 10 }), // unchanged
    ];
    expect(detectSyncMove(obs, THRESHOLDS)).toBeNull();
  });

  test("2 agents sync (below threshold of 3) → null", () => {
    const obs = [
      makeObs("a1", 1, { read: 10 }),
      makeObs("a2", 1, { read: 10 }),
      makeObs("a1", 2, { read: 15 }), // +50%
      makeObs("a2", 2, { read: 15 }), // +50%
    ];
    expect(detectSyncMove(obs, THRESHOLDS)).toBeNull();
  });

  test("3+ agents sync increase → fires", () => {
    const obs = [
      makeObs("a1", 1, { read: 10 }),
      makeObs("a2", 1, { read: 10 }),
      makeObs("a3", 1, { read: 10 }),
      makeObs("a1", 2, { read: 15 }), // +50%
      makeObs("a2", 2, { read: 14 }), // +40%
      makeObs("a3", 2, { read: 13 }), // +30%
    ];
    const signal = detectSyncMove(obs, THRESHOLDS);
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe("sync_move");
  });

  test("3+ agents sync decrease → fires", () => {
    const obs = [
      makeObs("a1", 1, { read: 10 }),
      makeObs("a2", 1, { read: 10 }),
      makeObs("a3", 1, { read: 10 }),
      makeObs("a1", 2, { read: 5 }), // -50%
      makeObs("a2", 2, { read: 6 }), // -40%
      makeObs("a3", 2, { read: 7 }), // -30%
    ];
    const signal = detectSyncMove(obs, THRESHOLDS);
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe("sync_move");
  });

  test("single agent present → null", () => {
    const obs = [makeObs("a1", 1, { read: 10 }), makeObs("a1", 2, { read: 15 })];
    expect(detectSyncMove(obs, THRESHOLDS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectVarianceCollapse
// ---------------------------------------------------------------------------

describe("detectVarianceCollapse", () => {
  test("empty observations → null", () => {
    expect(detectVarianceCollapse([], THRESHOLDS)).toBeNull();
  });

  test("fewer rounds than threshold → null", () => {
    const obs = [makeObs("a1", 1, { read: 10 }), makeObs("a2", 1, { read: 10 })];
    expect(detectVarianceCollapse(obs, THRESHOLDS)).toBeNull();
  });

  test("normal variation → null", () => {
    const obs: AgentObservation[] = [];
    for (const round of [1, 2, 3, 4, 5]) {
      obs.push(makeObs("a1", round, { read: 5 + round * 2 }));
      obs.push(makeObs("a2", round, { read: 20 - round }));
    }
    expect(detectVarianceCollapse(obs, THRESHOLDS)).toBeNull();
  });

  test("collapsed for 1 round (below minRounds) → null", () => {
    const obs: AgentObservation[] = [];
    // First 4 rounds: normal variation
    for (const round of [1, 2, 3, 4]) {
      obs.push(makeObs("a1", round, { read: 5 + round * 3 }));
      obs.push(makeObs("a2", round, { read: 20 - round * 2 }));
    }
    // Round 5: collapsed
    obs.push(makeObs("a1", 5, { read: 10 }));
    obs.push(makeObs("a2", 5, { read: 10 }));
    expect(detectVarianceCollapse(obs, THRESHOLDS)).toBeNull();
  });

  test("collapsed for 5+ consecutive rounds → fires", () => {
    const obs: AgentObservation[] = [];
    for (const round of [1, 2, 3, 4, 5]) {
      obs.push(makeObs("a1", round, { read: 10 }));
      obs.push(makeObs("a2", round, { read: 10 }));
      obs.push(makeObs("a3", round, { read: 10 }));
    }
    const signal = detectVarianceCollapse(obs, THRESHOLDS);
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe("variance_collapse");
  });

  test("single agent per round → null", () => {
    const obs: AgentObservation[] = [];
    for (const round of [1, 2, 3, 4, 5]) {
      obs.push(makeObs("a1", round, { read: 10 }));
    }
    expect(detectVarianceCollapse(obs, THRESHOLDS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectConcentration
// ---------------------------------------------------------------------------

describe("detectConcentration", () => {
  test("empty observations → null", () => {
    expect(detectConcentration([], THRESHOLDS)).toBeNull();
  });

  test("even distribution (low HHI) → null", () => {
    const obs = [
      makeObs("a1", 1, {}, { db: 25, api: 25 }),
      makeObs("a2", 1, {}, { db: 25, api: 25 }),
      makeObs("a3", 1, {}, { db: 25, api: 25 }),
      makeObs("a4", 1, {}, { db: 25, api: 25 }),
    ];
    expect(detectConcentration(obs, THRESHOLDS)).toBeNull();
  });

  test("concentrated access (high HHI) → fires", () => {
    const obs = [
      makeObs("a1", 1, {}, { db: 90 }),
      makeObs("a2", 1, {}, { db: 5 }),
      makeObs("a3", 1, {}, { db: 3 }),
      makeObs("a4", 1, {}, { db: 2 }),
    ];
    const signal = detectConcentration(obs, THRESHOLDS);
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe("concentration");
  });

  test("single agent → null (need multiple)", () => {
    const obs = [makeObs("a1", 1, {}, { db: 100 })];
    expect(detectConcentration(obs, THRESHOLDS)).toBeNull();
  });

  test("only looks at latest round", () => {
    const obs = [
      // Round 1: concentrated
      makeObs("a1", 1, {}, { db: 90 }),
      makeObs("a2", 1, {}, { db: 5 }),
      makeObs("a3", 1, {}, { db: 3 }),
      makeObs("a4", 1, {}, { db: 2 }),
      // Round 2: even distribution across 5 agents → HHI = 0.2
      makeObs("a1", 2, {}, { db: 20 }),
      makeObs("a2", 2, {}, { db: 20 }),
      makeObs("a3", 2, {}, { db: 20 }),
      makeObs("a4", 2, {}, { db: 20 }),
      makeObs("a5", 2, {}, { db: 20 }),
    ];
    // Should use round 2 (latest) which is even → HHI = 0.2 < 0.25 → null
    expect(detectConcentration(obs, THRESHOLDS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectSpecialization
// ---------------------------------------------------------------------------

describe("detectSpecialization", () => {
  test("empty observations → null", () => {
    expect(detectSpecialization([], THRESHOLDS)).toBeNull();
  });

  test("generalist agents (low CV) → null", () => {
    const obs = [
      makeObs("a1", 1, { read: 10, write: 10, delete: 10 }),
      makeObs("a2", 1, { read: 10, write: 10, delete: 10 }),
    ];
    expect(detectSpecialization(obs, THRESHOLDS)).toBeNull();
  });

  test("specialist agents (high CV) → fires", () => {
    // Each agent uses 5 tools but heavily specializes in one
    // [10000, 1, 1, 1, 1] → mean=2001, stddev≈4000, CV≈1.999
    // Use a slightly lower threshold to match realistic specialization
    const lowerThresholds: CollusionThresholds = {
      ...THRESHOLDS,
      specializationCvMin: 1.9,
    };
    const obs = [
      makeObs("a1", 1, { read: 10000, write: 1, delete: 1, exec: 1, list: 1 }),
      makeObs("a2", 1, { read: 1, write: 10000, delete: 1, exec: 1, list: 1 }),
      makeObs("a3", 1, { read: 1, write: 1, delete: 10000, exec: 1, list: 1 }),
    ];
    const signal = detectSpecialization(obs, lowerThresholds);
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe("specialization");
  });

  test("single agent → null", () => {
    const obs = [makeObs("a1", 1, { read: 100, write: 1 })];
    expect(detectSpecialization(obs, THRESHOLDS)).toBeNull();
  });

  test("agents with single tool each → null (can't compute meaningful CV)", () => {
    const obs = [makeObs("a1", 1, { read: 100 }), makeObs("a2", 1, { write: 100 })];
    expect(detectSpecialization(obs, THRESHOLDS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectAll
// ---------------------------------------------------------------------------

describe("detectAll", () => {
  test("no signals → empty array", () => {
    const signals = detectAll([], THRESHOLDS);
    expect(signals).toHaveLength(0);
  });

  test("returns all non-null signals", () => {
    // Create observations that trigger both variance collapse and concentration
    const obs: AgentObservation[] = [];
    for (const round of [1, 2, 3, 4, 5]) {
      obs.push(makeObs("a1", round, { read: 10 }, { db: 90 }));
      obs.push(makeObs("a2", round, { read: 10 }, { db: 5 }));
      obs.push(makeObs("a3", round, { read: 10 }, { db: 3 }));
      obs.push(makeObs("a4", round, { read: 10 }, { db: 2 }));
    }

    const signals = detectAll(obs, THRESHOLDS);
    expect(signals.length).toBeGreaterThan(0);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("variance_collapse");
    expect(kinds).toContain("concentration");
  });
});

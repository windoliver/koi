import { describe, expect, test } from "bun:test";
import { computeCrystallizeScore, computeSuccessRate } from "./compute-score.js";
import type { CrystallizationCandidate, OutcomeStats, ToolStep } from "./types.js";

function statsFromSteps(steps: readonly ToolStep[], occurrences: number): OutcomeStats {
  let successes = 0;
  let withOutcome = 0;
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    withOutcome += 1;
    if (step.outcome === "success") successes += 1;
  }
  return { successes: successes * occurrences, withOutcome: withOutcome * occurrences };
}

function makeCandidate(
  steps: readonly ToolStep[],
  occurrences: number,
  detectedAt: number,
  outcomeStats?: OutcomeStats,
): CrystallizationCandidate {
  const key = steps.map((s) => s.toolId).join("|");
  return {
    ngram: { steps, key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt,
    suggestedName: key,
    outcomeStats: outcomeStats ?? statsFromSteps(steps, occurrences),
  };
}

describe("computeSuccessRate", () => {
  test("returns 1.0 when no outcome data is present", () => {
    const c = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 3, 0);
    expect(computeSuccessRate(c)).toBe(1.0);
  });

  test("returns successes / steps-with-outcome from aggregate stats", () => {
    const c = makeCandidate([{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }], 1, 0, {
      successes: 2,
      withOutcome: 3,
    });
    expect(computeSuccessRate(c)).toBeCloseTo(2 / 3);
  });

  test("respects aggregate stats over single-occurrence representative", () => {
    // Representative steps look fully successful but aggregate shows mixed outcomes
    const c = makeCandidate(
      [
        { toolId: "a", outcome: "success" },
        { toolId: "b", outcome: "success" },
      ],
      5,
      0,
      { successes: 4, withOutcome: 10 },
    );
    expect(computeSuccessRate(c)).toBeCloseTo(0.4);
  });
});

describe("computeCrystallizeScore", () => {
  test("scales with occurrences and step count (frequency × complexity)", () => {
    const small = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 3, 0);
    const big = makeCandidate(
      [{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }, { toolId: "d" }],
      3,
      0,
    );
    const moreFrequent = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 6, 0);
    expect(computeCrystallizeScore(big, 0)).toBeGreaterThan(computeCrystallizeScore(small, 0));
    expect(computeCrystallizeScore(moreFrequent, 0)).toBeGreaterThan(
      computeCrystallizeScore(small, 0),
    );
  });

  test("decays exponentially with age (recency)", () => {
    const c = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 3, 0);
    const fresh = computeCrystallizeScore(c, 0);
    const halved = computeCrystallizeScore(c, 1_800_000);
    expect(halved).toBeCloseTo(fresh / 2);
  });

  test("respects custom recencyHalfLifeMs", () => {
    const c = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 3, 0);
    const halved = computeCrystallizeScore(c, 60_000, { recencyHalfLifeMs: 60_000 });
    expect(halved).toBeCloseTo(computeCrystallizeScore(c, 0) / 2);
  });

  test("penalizes patterns with failures via aggregate successRate", () => {
    const allGood = makeCandidate(
      [
        { toolId: "a", outcome: "success" },
        { toolId: "b", outcome: "success" },
      ],
      3,
      0,
    );
    const halfBad = makeCandidate(
      [
        { toolId: "a", outcome: "success" },
        { toolId: "b", outcome: "failure" },
      ],
      3,
      0,
    );
    expect(computeCrystallizeScore(halfBad, 0)).toBeLessThan(computeCrystallizeScore(allGood, 0));
  });

  test("treats now-before-detectedAt as zero age (no negative age boost)", () => {
    const c = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 3, 1000);
    expect(computeCrystallizeScore(c, 500)).toBe(computeCrystallizeScore(c, 1000));
  });
});

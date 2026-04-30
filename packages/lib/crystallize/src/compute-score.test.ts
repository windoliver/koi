import { describe, expect, test } from "bun:test";
import { computeCrystallizeScore, computeSuccessRate } from "./compute-score.js";
import type { CrystallizationCandidate } from "./types.js";

function makeCandidate(
  steps: readonly { readonly toolId: string; readonly outcome?: "success" | "failure" }[],
  occurrences: number,
  detectedAt: number,
): CrystallizationCandidate {
  const key = steps.map((s) => s.toolId).join("|");
  return {
    ngram: { steps, key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt,
    suggestedName: key,
  };
}

describe("computeSuccessRate", () => {
  test("returns 1.0 when no outcome data is present", () => {
    const c = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 3, 0);
    expect(computeSuccessRate(c)).toBe(1.0);
  });

  test("returns successes / steps-with-outcome", () => {
    const c = makeCandidate(
      [
        { toolId: "a", outcome: "success" },
        { toolId: "b", outcome: "failure" },
        { toolId: "c", outcome: "success" },
      ],
      3,
      0,
    );
    expect(computeSuccessRate(c)).toBeCloseTo(2 / 3);
  });

  test("ignores steps without outcome when computing rate", () => {
    const c = makeCandidate([{ toolId: "a", outcome: "success" }, { toolId: "b" }], 3, 0);
    expect(computeSuccessRate(c)).toBe(1.0);
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
    // One half-life — should halve.
    const halved = computeCrystallizeScore(c, 1_800_000);
    expect(halved).toBeCloseTo(fresh / 2);
  });

  test("respects custom recencyHalfLifeMs", () => {
    const c = makeCandidate([{ toolId: "a" }, { toolId: "b" }], 3, 0);
    const halved = computeCrystallizeScore(c, 60_000, { recencyHalfLifeMs: 60_000 });
    expect(halved).toBeCloseTo(computeCrystallizeScore(c, 0) / 2);
  });

  test("penalizes patterns with failures via successRate", () => {
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

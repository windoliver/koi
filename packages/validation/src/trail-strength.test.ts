import { describe, expect, test } from "bun:test";

import {
  computeEffectiveTrailStrength,
  computeTrailReinforcement,
  isTrailEvaporated,
} from "./trail-strength.js";

// ---------------------------------------------------------------------------
// Constants mirroring defaults from @koi/core TrailConfig
// ---------------------------------------------------------------------------

const TAU_MIN = 0.01;
const TAU_MAX = 0.95;
const HALF_LIFE_DAYS = 7;
const REINFORCEMENT = 0.1;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// computeEffectiveTrailStrength
// ---------------------------------------------------------------------------

describe("computeEffectiveTrailStrength", () => {
  test("returns clamped value when elapsed is zero", () => {
    expect(computeEffectiveTrailStrength(0.5, 0)).toBeCloseTo(0.5, 5);
  });

  test("returns clamped value when elapsed is negative (guard)", () => {
    expect(computeEffectiveTrailStrength(0.5, -1000)).toBeCloseTo(0.5, 5);
  });

  test("decays to roughly half after one half-life", () => {
    const oneHalfLife = HALF_LIFE_DAYS * MS_PER_DAY;
    const result = computeEffectiveTrailStrength(0.8, oneHalfLife);
    expect(result).toBeCloseTo(0.4, 2);
  });

  test("decays to roughly a quarter after two half-lives", () => {
    const twoHalfLives = 2 * HALF_LIFE_DAYS * MS_PER_DAY;
    const result = computeEffectiveTrailStrength(0.8, twoHalfLives);
    expect(result).toBeCloseTo(0.2, 2);
  });

  test("approaches tauMin with very large elapsed time", () => {
    const veryLargeElapsed = 365 * MS_PER_DAY; // 1 year
    const result = computeEffectiveTrailStrength(0.95, veryLargeElapsed);
    expect(result).toBe(TAU_MIN);
  });

  test("enforces tauMin floor on decayed value", () => {
    // After enough decay, result should be exactly tauMin, not lower
    const largeElapsed = 100 * MS_PER_DAY;
    const result = computeEffectiveTrailStrength(0.5, largeElapsed);
    expect(result).toBeGreaterThanOrEqual(TAU_MIN);
  });

  test("enforces tauMax cap when stored value exceeds tauMax", () => {
    // Stored value above tauMax at zero elapsed should be clamped to tauMax
    const result = computeEffectiveTrailStrength(1.5, 0);
    expect(result).toBe(TAU_MAX);
  });

  test("returns tauMin for NaN stored strength", () => {
    const result = computeEffectiveTrailStrength(NaN, 1000);
    expect(result).toBe(TAU_MIN);
  });

  test("returns tauMin for NaN elapsed time", () => {
    // NaN elapsed <= 0 is false, so it proceeds to decay
    // storedStrength * exp(-lambda * NaN) = NaN, guarded to tauMin
    const result = computeEffectiveTrailStrength(0.5, NaN);
    expect(result).toBe(TAU_MIN);
  });

  test("returns tauMin for Infinity stored strength", () => {
    const result = computeEffectiveTrailStrength(Infinity, 1000);
    expect(result).toBe(TAU_MIN);
  });

  test("returns tauMin for Infinity elapsed time", () => {
    const result = computeEffectiveTrailStrength(0.5, Infinity);
    expect(result).toBe(TAU_MIN);
  });

  test("returns tauMin for zero stored strength", () => {
    const result = computeEffectiveTrailStrength(0, MS_PER_DAY);
    // 0 * exp(-anything) = 0, which is below tauMin, so returns tauMin
    expect(result).toBe(TAU_MIN);
  });

  test("returns tauMin for zero half-life days", () => {
    const result = computeEffectiveTrailStrength(0.5, MS_PER_DAY, {
      halfLifeDays: 0,
    });
    expect(result).toBe(TAU_MIN);
  });

  test("returns tauMin for negative half-life days", () => {
    const result = computeEffectiveTrailStrength(0.5, MS_PER_DAY, {
      halfLifeDays: -3,
    });
    expect(result).toBe(TAU_MIN);
  });

  test("respects custom tauMin override", () => {
    const customMin = 0.2;
    const largeElapsed = 365 * MS_PER_DAY;
    const result = computeEffectiveTrailStrength(0.95, largeElapsed, {
      tauMin: customMin,
    });
    expect(result).toBe(customMin);
  });

  test("respects custom tauMax override", () => {
    const customMax = 0.6;
    const result = computeEffectiveTrailStrength(0.9, 0, {
      tauMax: customMax,
    });
    expect(result).toBe(customMax);
  });

  test("respects custom halfLifeDays override", () => {
    const customHalfLife = 1; // 1 day
    const oneDayMs = MS_PER_DAY;
    const result = computeEffectiveTrailStrength(0.8, oneDayMs, {
      halfLifeDays: customHalfLife,
    });
    expect(result).toBeCloseTo(0.4, 2);
  });

  test("returns clamped stored value for negative elapsed with high stored", () => {
    const result = computeEffectiveTrailStrength(2.0, -500);
    expect(result).toBe(TAU_MAX);
  });

  test("decays linearly in log-space (exponential decay property)", () => {
    const t1 = 3 * MS_PER_DAY;
    const t2 = 6 * MS_PER_DAY;
    const r1 = computeEffectiveTrailStrength(0.8, t1);
    const r2 = computeEffectiveTrailStrength(0.8, t2);
    // r2 should be approximately r1 squared / 0.8 (since r(2t) = r(t)^2 / r(0))
    // More precisely: r(t1) = 0.8 * exp(-lambda*t1), r(t2) = 0.8 * exp(-lambda*2*t1)
    // So r(t2) = r(t1)^2 / 0.8
    const expected = (r1 * r1) / 0.8;
    expect(r2).toBeCloseTo(expected, 5);
  });

  test("handles stored strength exactly at tauMin with zero elapsed", () => {
    const result = computeEffectiveTrailStrength(TAU_MIN, 0);
    expect(result).toBe(TAU_MIN);
  });

  test("handles stored strength exactly at tauMax with zero elapsed", () => {
    const result = computeEffectiveTrailStrength(TAU_MAX, 0);
    expect(result).toBe(TAU_MAX);
  });
});

// ---------------------------------------------------------------------------
// computeTrailReinforcement
// ---------------------------------------------------------------------------

describe("computeTrailReinforcement", () => {
  test("increases current strength by reinforcement amount", () => {
    const result = computeTrailReinforcement(0.3);
    expect(result).toBeCloseTo(0.3 + REINFORCEMENT, 5);
  });

  test("caps at tauMax when already at tauMax", () => {
    const result = computeTrailReinforcement(TAU_MAX);
    expect(result).toBe(TAU_MAX);
  });

  test("caps at tauMax when reinforcement would exceed tauMax", () => {
    const result = computeTrailReinforcement(0.9);
    // 0.9 + 0.1 = 1.0, but capped at 0.95
    expect(result).toBe(TAU_MAX);
  });

  test("reinforces from zero to tauMin + reinforcement", () => {
    const result = computeTrailReinforcement(0);
    expect(result).toBeCloseTo(REINFORCEMENT, 5);
  });

  test("reinforces from tauMin", () => {
    const result = computeTrailReinforcement(TAU_MIN);
    expect(result).toBeCloseTo(TAU_MIN + REINFORCEMENT, 5);
  });

  test("caps result near tauMax", () => {
    const result = computeTrailReinforcement(0.9);
    expect(result).toBeLessThanOrEqual(TAU_MAX);
  });

  test("returns tauMax for NaN input", () => {
    const result = computeTrailReinforcement(NaN);
    expect(result).toBe(TAU_MAX);
  });

  test("returns tauMax for Infinity input", () => {
    const result = computeTrailReinforcement(Infinity);
    expect(result).toBe(TAU_MAX);
  });

  test("returns tauMax for negative Infinity input", () => {
    const result = computeTrailReinforcement(-Infinity);
    expect(result).toBe(TAU_MAX);
  });

  test("respects custom reinforcement value", () => {
    const customReinforcement = 0.5;
    const result = computeTrailReinforcement(0.2, {
      reinforcement: customReinforcement,
    });
    expect(result).toBeCloseTo(0.2 + customReinforcement, 5);
  });

  test("respects custom tauMax", () => {
    const result = computeTrailReinforcement(0.4, { tauMax: 0.45 });
    // 0.4 + 0.1 = 0.5, capped at 0.45
    expect(result).toBe(0.45);
  });

  test("enforces tauMin floor for negative current strength", () => {
    const result = computeTrailReinforcement(-0.5);
    // -0.5 + 0.1 = -0.4, should be clamped to tauMin
    expect(result).toBeGreaterThanOrEqual(TAU_MIN);
  });
});

// ---------------------------------------------------------------------------
// isTrailEvaporated
// ---------------------------------------------------------------------------

describe("isTrailEvaporated", () => {
  test("fresh trail is not evaporated", () => {
    expect(isTrailEvaporated(0.5, 0)).toBe(false);
  });

  test("very old trail is evaporated", () => {
    const oneYear = 365 * MS_PER_DAY;
    expect(isTrailEvaporated(0.5, oneYear)).toBe(true);
  });

  test("trail exactly at tauMin is evaporated", () => {
    expect(isTrailEvaporated(TAU_MIN, 0)).toBe(true);
  });

  test("trail below tauMin at zero elapsed is evaporated", () => {
    expect(isTrailEvaporated(0.005, 0)).toBe(true);
  });

  test("zero elapsed with strength above tauMin is not evaporated", () => {
    expect(isTrailEvaporated(0.5, 0)).toBe(false);
  });

  test("trail just above tauMin is not evaporated at zero elapsed", () => {
    expect(isTrailEvaporated(TAU_MIN + 0.001, 0)).toBe(false);
  });

  test("trail decayed to near-tauMin over time is evaporated", () => {
    // With very large elapsed, even strong trail should evaporate
    const result = isTrailEvaporated(0.95, 200 * MS_PER_DAY);
    expect(result).toBe(true);
  });

  test("trail not yet evaporated after short time", () => {
    const oneHour = 3_600_000;
    expect(isTrailEvaporated(0.5, oneHour)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MMAS bounds invariants
// ---------------------------------------------------------------------------

describe("MMAS bounds invariants", () => {
  test("reinforcement never exceeds tauMax despite many applications", () => {
    let strength = 0.5;
    for (let i = 0; i < 100; i++) {
      strength = computeTrailReinforcement(strength);
    }
    expect(strength).toBeLessThanOrEqual(TAU_MAX);
    expect(strength).toBe(TAU_MAX);
  });

  test("decay never goes below tauMin despite huge elapsed time", () => {
    const hugeElapsed = 10_000 * MS_PER_DAY; // ~27 years
    const result = computeEffectiveTrailStrength(TAU_MAX, hugeElapsed);
    expect(result).toBeGreaterThanOrEqual(TAU_MIN);
    expect(result).toBe(TAU_MIN);
  });

  test("all results in [tauMin, tauMax] for random-like decay inputs", () => {
    const storedValues = [0, 0.001, 0.01, 0.1, 0.5, 0.95, 1.0, 2.0, 100];
    const elapsedValues = [0, 1, 1000, MS_PER_DAY, 30 * MS_PER_DAY, 365 * MS_PER_DAY];

    for (const stored of storedValues) {
      for (const elapsed of elapsedValues) {
        const result = computeEffectiveTrailStrength(stored, elapsed);
        expect(result).toBeGreaterThanOrEqual(TAU_MIN);
        expect(result).toBeLessThanOrEqual(TAU_MAX);
      }
    }
  });

  test("all results in [tauMin, tauMax] for random-like reinforcement inputs", () => {
    const inputValues = [-1, 0, 0.01, 0.1, 0.5, 0.9, 0.95, 1.5, 100];

    for (const input of inputValues) {
      const result = computeTrailReinforcement(input);
      expect(result).toBeGreaterThanOrEqual(TAU_MIN);
      expect(result).toBeLessThanOrEqual(TAU_MAX);
    }
  });

  test("decay followed by reinforcement stays in bounds", () => {
    const elapsed = 5 * MS_PER_DAY;
    const decayed = computeEffectiveTrailStrength(0.8, elapsed);
    const reinforced = computeTrailReinforcement(decayed);
    expect(reinforced).toBeGreaterThanOrEqual(TAU_MIN);
    expect(reinforced).toBeLessThanOrEqual(TAU_MAX);
  });

  test("repeated decay-reinforce cycles stay in bounds", () => {
    let strength = 0.5;
    for (let i = 0; i < 50; i++) {
      strength = computeEffectiveTrailStrength(strength, MS_PER_DAY);
      strength = computeTrailReinforcement(strength);
    }
    expect(strength).toBeGreaterThanOrEqual(TAU_MIN);
    expect(strength).toBeLessThanOrEqual(TAU_MAX);
  });
});

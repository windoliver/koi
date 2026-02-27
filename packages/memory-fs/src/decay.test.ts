import { describe, expect, test } from "bun:test";
import { classifyTier, computeDecayScore } from "./decay.js";

describe("computeDecayScore", () => {
  const HALF_LIFE = 30;

  test("returns ~1.0 for a freshly accessed fact", () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const score = computeDecayScore("2025-06-01T00:00:00Z", now, HALF_LIFE);
    expect(score).toBeCloseTo(1.0, 5);
  });

  test("returns ~0.5 at exactly one half-life", () => {
    const now = new Date("2025-07-01T00:00:00Z");
    const score = computeDecayScore("2025-06-01T00:00:00Z", now, HALF_LIFE);
    expect(score).toBeCloseTo(0.5, 1);
  });

  test("returns ~0.25 at two half-lives", () => {
    const now = new Date("2025-07-31T00:00:00Z");
    const score = computeDecayScore("2025-06-01T00:00:00Z", now, HALF_LIFE);
    expect(score).toBeCloseTo(0.25, 1);
  });

  test("returns near zero for very old facts", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const score = computeDecayScore("2025-01-01T00:00:00Z", now, HALF_LIFE);
    expect(score).toBeLessThan(0.01);
  });

  test("never returns negative values", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const score = computeDecayScore("2025-01-01T00:00:00Z", now, HALF_LIFE);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  test("handles future timestamps by clamping to 0 age", () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const score = computeDecayScore("2025-06-15T00:00:00Z", now, HALF_LIFE);
    expect(score).toBe(1.0);
  });
});

describe("classifyTier", () => {
  test("classifies hot for decayScore >= 0.7", () => {
    expect(classifyTier(0.7, 0, 10)).toBe("hot");
    expect(classifyTier(1.0, 0, 10)).toBe("hot");
    expect(classifyTier(0.85, 0, 10)).toBe("hot");
  });

  test("classifies warm for decayScore >= 0.3 but < 0.7", () => {
    expect(classifyTier(0.3, 0, 10)).toBe("warm");
    expect(classifyTier(0.5, 0, 10)).toBe("warm");
    expect(classifyTier(0.69, 0, 10)).toBe("warm");
  });

  test("classifies cold for decayScore < 0.3 with low access", () => {
    expect(classifyTier(0.1, 0, 10)).toBe("cold");
    expect(classifyTier(0.0, 5, 10)).toBe("cold");
    expect(classifyTier(0.29, 9, 10)).toBe("cold");
  });

  test("frequency protection: high access keeps warm despite low decay", () => {
    expect(classifyTier(0.1, 10, 10)).toBe("warm");
    expect(classifyTier(0.0, 15, 10)).toBe("warm");
    expect(classifyTier(0.05, 100, 10)).toBe("warm");
  });

  test("frequency protection does not override hot", () => {
    expect(classifyTier(0.8, 100, 10)).toBe("hot");
  });
});

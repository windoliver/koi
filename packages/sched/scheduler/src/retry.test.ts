import { describe, expect, it } from "bun:test";
import { computeBackoff } from "./retry.js";

const cfg = { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterMs: 0 };

describe("computeBackoff", () => {
  it("doubles with each attempt", () => {
    expect(computeBackoff(0, cfg)).toBe(1_000);
    expect(computeBackoff(1, cfg)).toBe(2_000);
    expect(computeBackoff(2, cfg)).toBe(4_000);
  });

  it("caps at maxDelayMs", () => {
    expect(computeBackoff(20, cfg)).toBe(60_000);
  });

  it("adds jitter", () => {
    const withJitter = { ...cfg, jitterMs: 500 };
    const result = computeBackoff(0, withJitter);
    expect(result).toBeGreaterThanOrEqual(1_000);
    expect(result).toBeLessThan(1_500);
  });
});

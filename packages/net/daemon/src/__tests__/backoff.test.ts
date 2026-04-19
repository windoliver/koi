import { describe, expect, it } from "bun:test";
import { computeBackoff } from "../backoff.js";

describe("computeBackoff", () => {
  it("returns base on attempt 0", () => {
    expect(computeBackoff(0, { baseMs: 1000, ceilingMs: 30_000 })).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(computeBackoff(1, { baseMs: 1000, ceilingMs: 30_000 })).toBe(2000);
    expect(computeBackoff(2, { baseMs: 1000, ceilingMs: 30_000 })).toBe(4000);
    expect(computeBackoff(3, { baseMs: 1000, ceilingMs: 30_000 })).toBe(8000);
  });

  it("caps at ceiling", () => {
    expect(computeBackoff(20, { baseMs: 1000, ceilingMs: 30_000 })).toBe(30_000);
  });

  it("handles attempt = 0 with baseMs = 0", () => {
    expect(computeBackoff(0, { baseMs: 0, ceilingMs: 30_000 })).toBe(0);
  });
});

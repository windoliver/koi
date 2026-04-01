import { describe, expect, test } from "bun:test";
import { computeRetryDelay } from "../retry.js";

const config = {
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 60_000,
  retryJitterMs: 500,
} as const;

describe("computeRetryDelay", () => {
  test("attempt 0 returns baseDelay + jitter", () => {
    const delay = computeRetryDelay(0, config);
    // base = 1000 * 2^0 = 1000, jitter in [0, 500)
    expect(delay).toBeGreaterThanOrEqual(1_000);
    expect(delay).toBeLessThan(1_500);
  });

  test("exponential growth per attempt", () => {
    const d0 = computeRetryDelay(0, { ...config, retryJitterMs: 0 });
    const d1 = computeRetryDelay(1, { ...config, retryJitterMs: 0 });
    const d2 = computeRetryDelay(2, { ...config, retryJitterMs: 0 });

    expect(d0).toBe(1_000);
    expect(d1).toBe(2_000);
    expect(d2).toBe(4_000);
  });

  test("capped at maxRetryDelayMs", () => {
    const delay = computeRetryDelay(20, { ...config, retryJitterMs: 0 });
    expect(delay).toBe(60_000);
  });

  test("jitter is bounded by retryJitterMs", () => {
    // Run multiple times to verify bounds
    for (let i = 0; i < 50; i++) {
      const delay = computeRetryDelay(0, config);
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThan(1_500);
    }
  });

  test("zero jitter returns exact exponential", () => {
    const delay = computeRetryDelay(3, { ...config, retryJitterMs: 0 });
    expect(delay).toBe(8_000); // 1000 * 2^3
  });
});

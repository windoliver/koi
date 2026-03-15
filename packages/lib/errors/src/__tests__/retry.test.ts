import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { isKoiError } from "../error-utils.js";
import {
  computeBackoff,
  DEFAULT_RECONNECT_CONFIG,
  DEFAULT_RETRY_CONFIG,
  isRetryable,
  withRetry,
} from "../retry.js";

function makeError(code: KoiError["code"], retryable = false, retryAfterMs?: number): KoiError {
  return {
    code,
    message: `${code} error`,
    retryable,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  };
}

describe("computeBackoff", () => {
  const noJitterConfig = { ...DEFAULT_RETRY_CONFIG, jitter: false };

  test("returns initial delay for attempt 0", () => {
    const delay = computeBackoff(0, noJitterConfig);
    expect(delay).toBe(1_000);
  });

  test("doubles delay on each attempt (multiplier=2)", () => {
    expect(computeBackoff(0, noJitterConfig)).toBe(1_000);
    expect(computeBackoff(1, noJitterConfig)).toBe(2_000);
    expect(computeBackoff(2, noJitterConfig)).toBe(4_000);
    expect(computeBackoff(3, noJitterConfig)).toBe(8_000);
  });

  test("respects maxBackoffMs ceiling", () => {
    const config = { ...noJitterConfig, maxBackoffMs: 5_000 };
    expect(computeBackoff(10, config)).toBe(5_000);
  });

  test("uses retryAfterMs when provided (overrides calculation)", () => {
    const delay = computeBackoff(0, noJitterConfig, 3_000);
    expect(delay).toBe(3_000);
  });

  test("clamps retryAfterMs to maxBackoffMs", () => {
    const config = { ...noJitterConfig, maxBackoffMs: 2_000 };
    const delay = computeBackoff(0, config, 10_000);
    expect(delay).toBe(2_000);
  });

  test("ignores retryAfterMs when zero", () => {
    const delay = computeBackoff(0, noJitterConfig, 0);
    expect(delay).toBe(1_000);
  });

  test("ignores negative retryAfterMs", () => {
    const delay = computeBackoff(0, noJitterConfig, -100);
    expect(delay).toBe(1_000);
  });

  test("applies jitter when enabled (result <= calculated delay)", () => {
    const config = { ...DEFAULT_RETRY_CONFIG, jitter: true };
    // Run multiple times to verify jitter produces values in range
    for (let i = 0; i < 20; i++) {
      const delay = computeBackoff(0, config);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(config.initialDelayMs);
    }
  });

  test("injectable random produces deterministic jitter", () => {
    const config = { ...DEFAULT_RETRY_CONFIG, jitter: true };
    const fixedRandom = () => 0.5;
    const delay = computeBackoff(0, config, undefined, fixedRandom);
    // 0.5 * 1000 = 500
    expect(delay).toBe(500);
  });

  test("custom backoff multiplier", () => {
    const config = { ...noJitterConfig, backoffMultiplier: 3 };
    expect(computeBackoff(0, config)).toBe(1_000);
    expect(computeBackoff(1, config)).toBe(3_000);
    expect(computeBackoff(2, config)).toBe(9_000);
  });

  test("decorrelated jitter uses prevDelayMs to compute upper bound", () => {
    const config = {
      ...DEFAULT_RETRY_CONFIG,
      jitter: true,
      jitterStrategy: "decorrelated" as const,
      initialDelayMs: 100,
      maxBackoffMs: 30_000,
    };
    const fixedRandom = () => 1; // max end of range
    // prevDelayMs = 500 → upper = min(30_000, max(100, 500*3)) = 1500
    // delay = floor(100 + 1 * (1500 - 100)) = 1500
    const delay = computeBackoff(0, config, undefined, fixedRandom, 500);
    expect(delay).toBe(1_500);
  });

  test("decorrelated jitter stays in [base, cap] range", () => {
    const config = {
      ...DEFAULT_RETRY_CONFIG,
      jitter: true,
      jitterStrategy: "decorrelated" as const,
      initialDelayMs: 100,
      maxBackoffMs: 5_000,
    };
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoff(0, config, undefined, undefined, 10_000);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(5_000);
    }
  });

  test("DEFAULT_RECONNECT_CONFIG uses decorrelated jitter strategy", () => {
    expect(DEFAULT_RECONNECT_CONFIG.jitterStrategy).toBe("decorrelated");
    expect(DEFAULT_RECONNECT_CONFIG.jitter).toBe(true);
    expect(DEFAULT_RECONNECT_CONFIG.maxRetries).toBe(10);
  });
});

describe("isRetryable", () => {
  test("RATE_LIMIT is retryable", () => {
    expect(isRetryable(makeError("RATE_LIMIT"))).toBe(true);
  });

  test("TIMEOUT is retryable", () => {
    expect(isRetryable(makeError("TIMEOUT"))).toBe(true);
  });

  test("EXTERNAL is retryable", () => {
    expect(isRetryable(makeError("EXTERNAL"))).toBe(true);
  });

  test("VALIDATION is not retryable", () => {
    expect(isRetryable(makeError("VALIDATION"))).toBe(false);
  });

  test("NOT_FOUND is not retryable", () => {
    expect(isRetryable(makeError("NOT_FOUND"))).toBe(false);
  });

  test("PERMISSION is not retryable", () => {
    expect(isRetryable(makeError("PERMISSION"))).toBe(false);
  });

  test("CONFLICT is retryable (matches RETRYABLE_DEFAULTS)", () => {
    expect(isRetryable(makeError("CONFLICT"))).toBe(true);
  });

  test("INTERNAL is not retryable", () => {
    expect(isRetryable(makeError("INTERNAL"))).toBe(false);
  });

  test("explicit retryable=true overrides code-based logic", () => {
    expect(isRetryable(makeError("VALIDATION", true))).toBe(true);
  });
});

describe("withRetry", () => {
  const fastConfig: typeof DEFAULT_RETRY_CONFIG = {
    maxRetries: 3,
    backoffMultiplier: 1,
    initialDelayMs: 1,
    maxBackoffMs: 10,
    jitter: false,
  };

  test("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve(42), fastConfig);
    expect(result).toBe(42);
  });

  test("retries on retryable error and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw makeError("RATE_LIMIT");
      }
      return Promise.resolve("success");
    }, fastConfig);
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  test("throws immediately on non-retryable error", async () => {
    let attempts = 0;
    try {
      await withRetry(() => {
        attempts++;
        throw makeError("VALIDATION");
      }, fastConfig);
      throw new Error("Should have thrown");
    } catch (error: unknown) {
      if (!isKoiError(error)) throw new Error("Expected KoiError");
      expect(error.code).toBe("VALIDATION");
      expect(attempts).toBe(1);
    }
  });

  test("throws after max retries exhausted", async () => {
    let attempts = 0;
    try {
      await withRetry(
        () => {
          attempts++;
          throw makeError("TIMEOUT");
        },
        { ...fastConfig, maxRetries: 2 },
      );
      throw new Error("Should have thrown");
    } catch (error: unknown) {
      if (!isKoiError(error)) throw new Error("Expected KoiError");
      expect(error.code).toBe("TIMEOUT");
      expect(attempts).toBe(3); // 1 initial + 2 retries
    }
  });

  test("converts non-KoiError to EXTERNAL error", async () => {
    try {
      await withRetry(
        () => {
          throw new Error("network failure");
        },
        { ...fastConfig, maxRetries: 0 },
      );
      throw new Error("Should have thrown");
    } catch (error: unknown) {
      if (!isKoiError(error)) throw new Error("Expected KoiError");
      expect(error.code).toBe("EXTERNAL");
      expect(error.message).toContain("network failure");
    }
  });

  test("respects retryAfterMs from error", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts === 1) {
          throw makeError("RATE_LIMIT", false, 10);
        }
        return Promise.resolve("ok");
      },
      { ...fastConfig, initialDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("zero maxRetries means no retries", async () => {
    let attempts = 0;
    try {
      await withRetry(
        () => {
          attempts++;
          throw makeError("TIMEOUT");
        },
        { ...fastConfig, maxRetries: 0 },
      );
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });
});

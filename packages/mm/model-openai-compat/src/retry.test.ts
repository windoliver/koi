/**
 * Tests for retry logic, backoff computation, and connection error detection.
 */

import { describe, expect, test } from "bun:test";
import {
  computeRetryDelay,
  DEFAULT_RETRY_CONFIG,
  isConnectionResetError,
  isConnectionResetMessage,
  isRetryableStatus,
  sleepWithSignal,
} from "./retry.js";

describe("isRetryableStatus", () => {
  test("408 is retryable", () => expect(isRetryableStatus(408)).toBe(true));
  test("429 is retryable", () => expect(isRetryableStatus(429)).toBe(true));
  test("529 is retryable", () => expect(isRetryableStatus(529)).toBe(true));
  test("500 is retryable", () => expect(isRetryableStatus(500)).toBe(true));
  test("502 is retryable", () => expect(isRetryableStatus(502)).toBe(true));
  test("503 is retryable", () => expect(isRetryableStatus(503)).toBe(true));
  test("401 is not retryable", () => expect(isRetryableStatus(401)).toBe(false));
  test("403 is not retryable", () => expect(isRetryableStatus(403)).toBe(false));
  test("404 is not retryable", () => expect(isRetryableStatus(404)).toBe(false));
  test("200 is not retryable", () => expect(isRetryableStatus(200)).toBe(false));
});

describe("isConnectionResetMessage", () => {
  test("detects ECONNRESET", () => expect(isConnectionResetMessage("read ECONNRESET")).toBe(true));
  test("detects EPIPE", () => expect(isConnectionResetMessage("write EPIPE")).toBe(true));
  test("detects socket hang up", () =>
    expect(isConnectionResetMessage("socket hang up")).toBe(true));
  test("case insensitive", () => expect(isConnectionResetMessage("Read econnreset")).toBe(true));
  test("rejects generic messages", () => expect(isConnectionResetMessage("timeout")).toBe(false));
});

describe("isConnectionResetError", () => {
  test("detects ECONNRESET", () => {
    expect(isConnectionResetError(new Error("read ECONNRESET"))).toBe(true);
  });
  test("detects EPIPE", () => {
    expect(isConnectionResetError(new Error("write EPIPE"))).toBe(true);
  });
  test("detects socket hang up", () => {
    expect(isConnectionResetError(new Error("socket hang up"))).toBe(true);
  });
  test("rejects generic errors", () => {
    expect(isConnectionResetError(new Error("timeout"))).toBe(false);
  });
  test("rejects non-errors", () => {
    expect(isConnectionResetError("string")).toBe(false);
  });
});

describe("computeRetryDelay", () => {
  const config = { ...DEFAULT_RETRY_CONFIG, jitterFactor: 0 }; // No jitter for deterministic tests

  test("attempt 0 = baseDelay", () => {
    expect(computeRetryDelay(0, config)).toBe(500);
  });
  test("attempt 1 = baseDelay * 2", () => {
    expect(computeRetryDelay(1, config)).toBe(1000);
  });
  test("attempt 2 = baseDelay * 4", () => {
    expect(computeRetryDelay(2, config)).toBe(2000);
  });
  test("caps at maxDelayMs", () => {
    expect(computeRetryDelay(10, config)).toBe(32_000);
  });
  test("respects retryAfterMs from provider", () => {
    expect(computeRetryDelay(0, config, 5000)).toBe(5000);
  });
  test("caps retryAfterMs at maxDelayMs", () => {
    expect(computeRetryDelay(0, config, 100_000)).toBe(32_000);
  });
  test("with jitter, stays within ±25% of base", () => {
    const results = Array.from({ length: 100 }, () => computeRetryDelay(0, DEFAULT_RETRY_CONFIG));
    const min = Math.min(...results);
    const max = Math.max(...results);
    // 500 ± 25% = [375, 625]
    expect(min).toBeGreaterThanOrEqual(375);
    expect(max).toBeLessThanOrEqual(625);
  });
});

describe("sleepWithSignal", () => {
  test("resolves true after delay", async () => {
    const result = await sleepWithSignal(10);
    expect(result).toBe(true);
  });

  test("resolves false when signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await sleepWithSignal(1000, controller.signal);
    expect(result).toBe(false);
  });

  test("resolves false when signal aborted during sleep", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await sleepWithSignal(5000, controller.signal);
    expect(result).toBe(false);
  });
});

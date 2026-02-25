/**
 * Circuit breaker unit tests.
 *
 * Tests the per-delegatee circuit breaker state machine:
 *   closed → open → half_open → closed (on success)
 *   closed → open → half_open → open (on failure)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createCircuitBreaker } from "./circuit-breaker.js";

describe("createCircuitBreaker", () => {
  test("starts in closed state", () => {
    const cb = createCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(cb.getState("agent-1")).toBe("closed");
  });

  test("stays closed below failure threshold", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      halfOpenMaxProbes: 1,
    });

    for (let i = 0; i < 4; i++) {
      cb.recordFailure("agent-1");
    }

    expect(cb.getState("agent-1")).toBe("closed");
    expect(cb.canExecute("agent-1")).toBe(true);
  });

  test("transitions to open after failureThreshold failures", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 30_000,
      halfOpenMaxProbes: 1,
    });

    cb.recordFailure("agent-1");
    cb.recordFailure("agent-1");
    cb.recordFailure("agent-1");

    expect(cb.getState("agent-1")).toBe("open");
    expect(cb.canExecute("agent-1")).toBe(false);
  });

  test("returns fast-fail when circuit is open", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 30_000,
      halfOpenMaxProbes: 1,
    });

    cb.recordFailure("agent-1");

    expect(cb.canExecute("agent-1")).toBe(false);
  });

  test("transitions to half-open after resetTimeoutMs", () => {
    let now = 1000;
    const cb = createCircuitBreaker(
      { failureThreshold: 1, resetTimeoutMs: 5_000, halfOpenMaxProbes: 1 },
      () => now,
    );

    cb.recordFailure("agent-1");
    expect(cb.getState("agent-1")).toBe("open");

    // Advance time past resetTimeoutMs
    now = 7_000;
    expect(cb.getState("agent-1")).toBe("half_open");
    expect(cb.canExecute("agent-1")).toBe(true);
  });

  test("closes circuit on successful half-open probe", () => {
    let now = 1000;
    const cb = createCircuitBreaker(
      { failureThreshold: 1, resetTimeoutMs: 5_000, halfOpenMaxProbes: 1 },
      () => now,
    );

    cb.recordFailure("agent-1");
    expect(cb.getState("agent-1")).toBe("open");

    // Advance to half-open
    now = 7_000;
    expect(cb.getState("agent-1")).toBe("half_open");

    // Successful probe → closed
    cb.recordSuccess("agent-1");
    expect(cb.getState("agent-1")).toBe("closed");
    expect(cb.canExecute("agent-1")).toBe(true);
  });

  test("reopens circuit on failed half-open probe", () => {
    let now = 1000;
    const cb = createCircuitBreaker(
      { failureThreshold: 1, resetTimeoutMs: 5_000, halfOpenMaxProbes: 1 },
      () => now,
    );

    cb.recordFailure("agent-1");
    now = 7_000; // half-open

    // Failed probe → re-open
    cb.recordFailure("agent-1");
    expect(cb.getState("agent-1")).toBe("open");
    expect(cb.canExecute("agent-1")).toBe(false);
  });

  test("tracks failure counts per delegatee independently", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 30_000,
      halfOpenMaxProbes: 1,
    });

    cb.recordFailure("agent-1");
    cb.recordFailure("agent-1");

    cb.recordFailure("agent-2");

    expect(cb.getState("agent-1")).toBe("open");
    expect(cb.getState("agent-2")).toBe("closed");
    expect(cb.canExecute("agent-2")).toBe(true);
  });

  test("resets failure count on success", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 30_000,
      halfOpenMaxProbes: 1,
    });

    cb.recordFailure("agent-1");
    cb.recordFailure("agent-1");
    // 2 failures, threshold is 3
    cb.recordSuccess("agent-1");

    // After success, failure count resets — need 3 more failures to open
    cb.recordFailure("agent-1");
    cb.recordFailure("agent-1");
    expect(cb.getState("agent-1")).toBe("closed");

    cb.recordFailure("agent-1");
    expect(cb.getState("agent-1")).toBe("open");
  });

  test("unknown delegatee defaults to closed", () => {
    const cb = createCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(cb.getState("never-seen")).toBe("closed");
    expect(cb.canExecute("never-seen")).toBe(true);
  });
});

/**
 * Tests for Temporal health monitor with circuit breaker.
 * Decision 8C: Health check + circuit breaker.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createTemporalHealthMonitor,
  type TemporalHealthConfig,
  type TemporalHealthMonitor,
} from "./temporal-health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(overrides?: Partial<TemporalHealthConfig>): TemporalHealthConfig {
  return {
    url: "localhost:7233",
    pollIntervalMs: 100,
    failureThreshold: 3,
    cooldownMs: 1_000,
    timeoutMs: 500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic health monitoring
// ---------------------------------------------------------------------------

describe("createTemporalHealthMonitor", () => {
  let monitor: TemporalHealthMonitor;

  afterEach(() => {
    monitor?.dispose();
  });

  test("starts in healthy state", () => {
    const healthCheck = mock(async () => true);
    monitor = createTemporalHealthMonitor(createTestConfig(), healthCheck);

    const snap = monitor.snapshot();
    expect(snap.status).toBe("healthy");
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.url).toBe("localhost:7233");
  });

  test("isAvailable returns true when healthy", () => {
    const healthCheck = mock(async () => true);
    monitor = createTemporalHealthMonitor(createTestConfig(), healthCheck);

    expect(monitor.isAvailable()).toBe(true);
  });

  test("polls health check on start", async () => {
    const healthCheck = mock(async () => true);
    monitor = createTemporalHealthMonitor(createTestConfig(), healthCheck);

    monitor.start();
    // Wait for initial poll
    await new Promise((r) => setTimeout(r, 50));

    expect(healthCheck).toHaveBeenCalled();
    expect(monitor.snapshot().status).toBe("healthy");
  });

  test("tracks consecutive failures", async () => {
    const healthCheck = mock(async () => false);
    monitor = createTemporalHealthMonitor(createTestConfig(), healthCheck);

    monitor.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(monitor.snapshot().consecutiveFailures).toBe(1);
  });

  test("resets failures on success", async () => {
    let shouldFail = true;
    const healthCheck = mock(async () => !shouldFail);
    monitor = createTemporalHealthMonitor(createTestConfig({ pollIntervalMs: 50 }), healthCheck);

    monitor.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(monitor.snapshot().consecutiveFailures).toBe(1);

    shouldFail = false;
    await new Promise((r) => setTimeout(r, 80));
    expect(monitor.snapshot().consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker behavior
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  let monitor: TemporalHealthMonitor;

  afterEach(() => {
    monitor?.dispose();
  });

  test("trips circuit after threshold consecutive failures", async () => {
    const healthCheck = mock(async () => false);
    monitor = createTemporalHealthMonitor(
      createTestConfig({ pollIntervalMs: 30, failureThreshold: 3 }),
      healthCheck,
    );

    monitor.start();
    // Wait for 3+ polls
    await new Promise((r) => setTimeout(r, 150));

    expect(monitor.snapshot().status).toBe("unavailable");
    expect(monitor.isAvailable()).toBe(false);
  });

  test("notifies listeners on status change", async () => {
    const healthCheck = mock(async () => false);
    monitor = createTemporalHealthMonitor(
      createTestConfig({ pollIntervalMs: 30, failureThreshold: 3 }),
      healthCheck,
    );

    const statusChanges: string[] = [];
    monitor.onStatusChange((snap) => {
      statusChanges.push(snap.status);
    });

    monitor.start();
    await new Promise((r) => setTimeout(r, 150));

    // Should have transitioned: healthy → unavailable
    expect(statusChanges).toContain("unavailable");
  });

  test("unsubscribe stops notifications", async () => {
    const healthCheck = mock(async () => false);
    monitor = createTemporalHealthMonitor(
      createTestConfig({ pollIntervalMs: 30, failureThreshold: 3 }),
      healthCheck,
    );

    const statusChanges: string[] = [];
    const unsub = monitor.onStatusChange((snap) => {
      statusChanges.push(snap.status);
    });

    unsub();

    monitor.start();
    await new Promise((r) => setTimeout(r, 150));

    expect(statusChanges).toHaveLength(0);
  });

  test("handles health check exceptions", async () => {
    const healthCheck = mock(async () => {
      throw new Error("Connection refused");
    });
    monitor = createTemporalHealthMonitor(
      createTestConfig({ pollIntervalMs: 30, failureThreshold: 2 }),
      healthCheck,
    );

    monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(monitor.snapshot().consecutiveFailures).toBeGreaterThanOrEqual(2);
  });

  test("non-consecutive failures do not trip circuit (fail-fail-success-fail-fail stays healthy)", async () => {
    // Pattern: fail, fail, success, fail, fail — threshold=3
    // With consecutive-only logic, the success resets the counter,
    // so it should NOT trip (max consecutive = 2 < threshold 3).
    let callCount = 0;
    const healthCheck = mock(async () => {
      callCount++;
      // fail, fail, success, fail, fail, then success forever
      if (callCount === 3 || callCount > 5) return true;
      return false;
    });
    monitor = createTemporalHealthMonitor(
      createTestConfig({ pollIntervalMs: 20, failureThreshold: 3 }),
      healthCheck,
    );

    monitor.start();
    // Wait for enough polls to cover the full pattern
    await new Promise((r) => setTimeout(r, 200));

    // Should still be healthy — no run of 3 consecutive failures
    expect(callCount).toBeGreaterThanOrEqual(5);
    expect(monitor.snapshot().status).toBe("healthy");
    expect(monitor.isAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("stops polling after dispose", async () => {
    const healthCheck = mock(async () => true);
    const monitor = createTemporalHealthMonitor(
      createTestConfig({ pollIntervalMs: 30 }),
      healthCheck,
    );

    monitor.start();
    await new Promise((r) => setTimeout(r, 50));
    const callsBefore = healthCheck.mock.calls.length;

    monitor.dispose();
    await new Promise((r) => setTimeout(r, 100));

    // No new calls after dispose
    expect(healthCheck.mock.calls.length).toBe(callsBefore);
  });

  test("double start is idempotent", () => {
    const healthCheck = mock(async () => true);
    const monitor = createTemporalHealthMonitor(createTestConfig(), healthCheck);

    monitor.start();
    monitor.start(); // Should not create second timer

    monitor.dispose();
  });
});

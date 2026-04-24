import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createTemporalHealthMonitor,
  type TemporalHealthConfig,
  type TemporalHealthMonitor,
} from "./temporal-health.js";

function makeConfig(overrides?: Partial<TemporalHealthConfig>): TemporalHealthConfig {
  return {
    url: "localhost:7233",
    pollIntervalMs: 100,
    failureThreshold: 3,
    cooldownMs: 1_000,
    timeoutMs: 500,
    ...overrides,
  };
}

describe("createTemporalHealthMonitor", () => {
  let monitor: TemporalHealthMonitor;

  afterEach(() => {
    monitor?.dispose();
  });

  test("starts in healthy state", () => {
    monitor = createTemporalHealthMonitor(
      makeConfig(),
      mock(async () => true),
    );
    const snap = monitor.snapshot();
    expect(snap.status).toBe("healthy");
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.url).toBe("localhost:7233");
  });

  test("isAvailable returns true when healthy", () => {
    monitor = createTemporalHealthMonitor(
      makeConfig(),
      mock(async () => true),
    );
    expect(monitor.isAvailable()).toBe(true);
  });

  test("polls health check on start", async () => {
    const healthCheck = mock(async () => true);
    monitor = createTemporalHealthMonitor(makeConfig(), healthCheck);
    monitor.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(healthCheck).toHaveBeenCalled();
    expect(monitor.snapshot().status).toBe("healthy");
  });

  test("tracks consecutive failures", async () => {
    const healthCheck = mock(async () => false);
    monitor = createTemporalHealthMonitor(makeConfig(), healthCheck);
    monitor.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(monitor.snapshot().consecutiveFailures).toBe(1);
  });

  test("resets failures on success", async () => {
    let shouldFail = true;
    const healthCheck = mock(async () => !shouldFail);
    monitor = createTemporalHealthMonitor(makeConfig({ pollIntervalMs: 50 }), healthCheck);
    monitor.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(monitor.snapshot().consecutiveFailures).toBe(1);
    shouldFail = false;
    await new Promise((r) => setTimeout(r, 80));
    expect(monitor.snapshot().consecutiveFailures).toBe(0);
  });
});

describe("circuit breaker", () => {
  let monitor: TemporalHealthMonitor;

  afterEach(() => {
    monitor?.dispose();
  });

  test("trips circuit after threshold consecutive failures", async () => {
    monitor = createTemporalHealthMonitor(
      makeConfig({ pollIntervalMs: 30, failureThreshold: 3 }),
      mock(async () => false),
    );
    monitor.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(monitor.snapshot().status).toBe("unavailable");
    expect(monitor.isAvailable()).toBe(false);
  });

  test("notifies listeners on status change", async () => {
    monitor = createTemporalHealthMonitor(
      makeConfig({ pollIntervalMs: 30, failureThreshold: 3 }),
      mock(async () => false),
    );
    const statusChanges: string[] = [];
    monitor.onStatusChange((snap) => {
      statusChanges.push(snap.status);
    });
    monitor.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(statusChanges).toContain("unavailable");
  });

  test("unsubscribe stops notifications", async () => {
    monitor = createTemporalHealthMonitor(
      makeConfig({ pollIntervalMs: 30, failureThreshold: 3 }),
      mock(async () => false),
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
    monitor = createTemporalHealthMonitor(
      makeConfig({ pollIntervalMs: 30, failureThreshold: 2 }),
      mock(async () => {
        throw new Error("Connection refused");
      }),
    );
    monitor.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(monitor.snapshot().consecutiveFailures).toBeGreaterThanOrEqual(2);
  });

  test("non-consecutive failures do not trip circuit when success resets counter", async () => {
    let callCount = 0;
    const healthCheck = mock(async () => {
      callCount++;
      if (callCount === 3 || callCount > 5) return true;
      return false;
    });
    monitor = createTemporalHealthMonitor(
      makeConfig({ pollIntervalMs: 20, failureThreshold: 3 }),
      healthCheck,
    );
    monitor.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(callCount).toBeGreaterThanOrEqual(5);
    expect(monitor.snapshot().status).toBe("healthy");
    expect(monitor.isAvailable()).toBe(true);
  });
});

describe("circuit breaker — isAvailable is side-effect free", () => {
  let monitor: TemporalHealthMonitor;

  afterEach(() => {
    monitor?.dispose();
  });

  test("isAvailable stays false during OPEN and HALF_OPEN — only CLOSED returns true", async () => {
    // Trip the circuit
    const healthCheck = mock(async () => false);
    monitor = createTemporalHealthMonitor(
      makeConfig({ pollIntervalMs: 30, failureThreshold: 3, cooldownMs: 50 }),
      healthCheck,
    );
    monitor.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(monitor.isAvailable()).toBe(false);
    expect(monitor.snapshot().status).toBe("unavailable");

    // After cooldown, poll transitions OPEN → HALF_OPEN and runs a probe.
    // Health check still failing → probe fails → stays OPEN (or re-opens from HALF_OPEN).
    // isAvailable() must NOT return true just because cooldown elapsed.
    await new Promise((r) => setTimeout(r, 120));
    expect(monitor.isAvailable()).toBe(false);
  });

  test("isAvailable becomes true only after a successful probe post-cooldown", async () => {
    let shouldSucceed = false;
    const healthCheck = mock(async () => shouldSucceed);
    monitor = createTemporalHealthMonitor(
      makeConfig({ pollIntervalMs: 30, failureThreshold: 3, cooldownMs: 50 }),
      healthCheck,
    );
    monitor.start();

    // Trip the circuit
    await new Promise((r) => setTimeout(r, 150));
    expect(monitor.isAvailable()).toBe(false);

    // Let the dependency recover and wait for a successful probe
    shouldSucceed = true;
    await new Promise((r) => setTimeout(r, 150));
    expect(monitor.isAvailable()).toBe(true);
    expect(monitor.snapshot().status).toBe("healthy");
  });
});

describe("dispose", () => {
  test("stops polling after dispose", async () => {
    const healthCheck = mock(async () => true);
    const monitor = createTemporalHealthMonitor(makeConfig({ pollIntervalMs: 30 }), healthCheck);
    monitor.start();
    await new Promise((r) => setTimeout(r, 50));
    const callsBefore = healthCheck.mock.calls.length;
    monitor.dispose();
    await new Promise((r) => setTimeout(r, 100));
    expect(healthCheck.mock.calls.length).toBe(callsBefore);
  });

  test("double start is idempotent", () => {
    const monitor = createTemporalHealthMonitor(
      makeConfig(),
      mock(async () => true),
    );
    monitor.start();
    monitor.start();
    monitor.dispose();
  });
});

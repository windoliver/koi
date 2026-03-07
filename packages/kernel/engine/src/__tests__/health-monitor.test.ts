import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import type { InMemoryHealthMonitor, InMemoryRegistry } from "@koi/engine-reconcile";
import { createHealthMonitor, createInMemoryRegistry } from "@koi/engine-reconcile";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function registerAgent(registry: InMemoryRegistry, id: string): void {
  registry.register({
    agentId: agentId(id),
    status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
    agentType: "worker",
    priority: 10,
    metadata: {},
    registeredAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HealthMonitor", () => {
  let registry: InMemoryRegistry;
  let monitor: InMemoryHealthMonitor;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    if (monitor) await monitor[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  // --- Record ---

  test("record increases buffer size", () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000, // long — won't auto-flush
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    monitor.record(agentId("a1"));

    expect(monitor.stats().bufferSize).toBe(1);
    expect(monitor.stats().totalRecorded).toBe(1);
  });

  test("multiple records for same agent keeps buffer size at 1", () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    monitor.record(agentId("a1"));
    monitor.record(agentId("a1"));
    monitor.record(agentId("a1"));

    expect(monitor.stats().bufferSize).toBe(1);
    expect(monitor.stats().totalRecorded).toBe(3);
  });

  // --- Check ---

  test("check returns alive for recently heartbeated agent", () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    monitor.record(agentId("a1"));

    const snapshot = monitor.check(agentId("a1"));
    expect(snapshot.status).toBe("alive");
    expect(snapshot.missedChecks).toBe(0);
  });

  test("check returns dead for agent with no heartbeat and stale transition", () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 1000,
      deadThresholdMs: 2000,
    });

    // Register agent with a lastTransitionAt far in the past
    registry.register({
      agentId: agentId("a-stale"),
      status: {
        phase: "running",
        generation: 1,
        conditions: [],
        lastTransitionAt: Date.now() - 10_000, // 10s ago
      },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now() - 10_000,
    });
    // No heartbeat recorded

    const snapshot = monitor.check(agentId("a-stale"));
    expect(snapshot.status).toBe("dead");
    expect(snapshot.missedChecks).toBeGreaterThan(0);
  });

  // --- Flush ---

  test("flush clears buffer and increments stats", () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    registerAgent(registry, "a2");
    monitor.record(agentId("a1"));
    monitor.record(agentId("a2"));

    monitor.flush();

    const stats = monitor.stats();
    expect(stats.bufferSize).toBe(0);
    expect(stats.totalFlushed).toBe(2);
    expect(stats.flushCount).toBe(1);
  });

  // --- Flush preserves heartbeat for check ---

  test("check returns alive after flush (heartbeats survive flush)", () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    monitor.record(agentId("a1"));

    // Flush moves heartbeat from buffer to flushed store
    monitor.flush();
    expect(monitor.stats().bufferSize).toBe(0);

    // check() should still find the heartbeat via flushed store
    const snapshot = monitor.check(agentId("a1"));
    expect(snapshot.status).toBe("alive");
    expect(snapshot.lastHeartbeat).toBeGreaterThan(0);
  });

  // --- Cleanup on deregister ---

  test("deregistering agent cleans up heartbeat data", () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    monitor.record(agentId("a1"));
    monitor.flush();

    // Agent deregistered — heartbeat data should be cleaned
    registry.deregister(agentId("a1"));

    // check() should fall back to lastHeartbeat=0 → dead with missedChecks=0
    const snapshot = monitor.check(agentId("a1"));
    expect(snapshot.status).toBe("dead");
    expect(snapshot.lastHeartbeat).toBe(0);
    expect(snapshot.missedChecks).toBe(0);
  });

  // --- Auto-flush via timer ---

  test("auto-flush fires at configured interval", async () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 50, // 50ms — fast for testing
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    monitor.record(agentId("a1"));

    // Wait for auto-flush
    await new Promise((r) => setTimeout(r, 150));

    expect(monitor.stats().bufferSize).toBe(0);
    expect(monitor.stats().flushCount).toBeGreaterThanOrEqual(1);
  });

  // --- Dispose ---

  test("dispose flushes remaining buffer and stops timers", async () => {
    monitor = createHealthMonitor(registry, {
      flushIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      suspectThresholdMs: 60_000,
      deadThresholdMs: 120_000,
    });

    registerAgent(registry, "a1");
    monitor.record(agentId("a1"));

    await monitor[Symbol.asyncDispose]();

    expect(monitor.stats().bufferSize).toBe(0);
    expect(monitor.stats().totalFlushed).toBe(1);
  });
});

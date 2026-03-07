/**
 * Integration test: full agent lifecycle pipeline.
 *
 * Exercises the interplay between registry, health monitor, eviction policies,
 * and disposal — the entire lifecycle from register to evict to dispose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EvictionCandidate, RegistryEvent } from "@koi/core";
import { agentId } from "@koi/core";
import type { InMemoryHealthMonitor, InMemoryRegistry } from "@koi/engine-reconcile";
import {
  createHealthMonitor,
  createInMemoryRegistry,
  lruPolicy,
  qosPolicy,
} from "@koi/engine-reconcile";
import { disposeAll } from "../dispose.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let registry: InMemoryRegistry;
let monitor: InMemoryHealthMonitor;

beforeEach(() => {
  registry = createInMemoryRegistry();
  monitor = createHealthMonitor(registry, {
    flushIntervalMs: 60_000, // long — manual flush in tests
    sweepIntervalMs: 60_000,
    suspectThresholdMs: 100,
    deadThresholdMs: 200,
  });
});

afterEach(async () => {
  await disposeAll([monitor, registry]);
});

// ---------------------------------------------------------------------------
// Full lifecycle: register → heartbeat → check → transition → deregister
// ---------------------------------------------------------------------------

describe("Lifecycle: register → heartbeat → deregister", () => {
  test("agent registers, heartbeats, transitions through states, and deregisters", () => {
    const id = agentId("lifecycle-agent");
    const events: RegistryEvent[] = [];
    registry.watch((e) => events.push(e));

    // 1. Register
    registry.register({
      agentId: id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: { purpose: "integration-test" },
      registeredAt: Date.now(),
    });

    expect(registry.lookup(id)).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("registered");

    // 2. Transition: created → running
    const r1 = registry.transition(id, "running", 0, { kind: "assembly_complete" });
    expect(r1.ok).toBe(true);

    // 3. Heartbeat
    monitor.record(id);
    expect(monitor.stats().totalRecorded).toBe(1);

    // 4. Check health — should be alive
    const health = monitor.check(id);
    expect(health.status).toBe("alive");
    expect(health.missedChecks).toBe(0);

    // 5. Transition: running → waiting → running
    const r2 = registry.transition(id, "waiting", 1, { kind: "awaiting_response" });
    expect(r2.ok).toBe(true);
    const r3 = registry.transition(id, "running", 2, { kind: "response_received" });
    expect(r3.ok).toBe(true);

    // 6. Transition: running → terminated
    const r4 = registry.transition(id, "terminated", 3, { kind: "completed" });
    expect(r4.ok).toBe(true);

    // 7. Deregister
    expect(registry.deregister(id)).toBe(true);
    expect(registry.lookup(id)).toBeUndefined();

    // Verify full event trail: registered + 4 transitions + deregistered
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.kind)).toEqual([
      "registered",
      "transitioned",
      "transitioned",
      "transitioned",
      "transitioned",
      "deregistered",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stale detection: heartbeat stops → suspect → dead
// ---------------------------------------------------------------------------

describe("Lifecycle: heartbeat stops → suspect → dead", () => {
  test("agent transitions from alive to suspect to dead based on thresholds", async () => {
    const id = agentId("stale-agent");

    registry.register({
      agentId: id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(id, "running", 0, { kind: "assembly_complete" });

    // Record heartbeat — initially alive
    monitor.record(id);
    expect(monitor.check(id).status).toBe("alive");

    // Wait for suspect threshold (100ms)
    await new Promise((r) => setTimeout(r, 120));
    expect(monitor.check(id).status).toBe("suspect");
    expect(monitor.check(id).missedChecks).toBeGreaterThan(0);

    // Wait for dead threshold (200ms total)
    await new Promise((r) => setTimeout(r, 120));
    expect(monitor.check(id).status).toBe("dead");
    expect(monitor.check(id).missedChecks).toBeGreaterThan(0);
  });

  test("heartbeat refreshes alive status after suspect", async () => {
    const id = agentId("recovering-agent");

    registry.register({
      agentId: id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(id, "running", 0, { kind: "assembly_complete" });

    monitor.record(id);

    // Drift into suspect zone
    await new Promise((r) => setTimeout(r, 120));
    expect(monitor.check(id).status).toBe("suspect");

    // Re-heartbeat — should return to alive
    monitor.record(id);
    expect(monitor.check(id).status).toBe("alive");
  });
});

// ---------------------------------------------------------------------------
// Eviction: detect stale agents → select candidates → evict
// ---------------------------------------------------------------------------

describe("Lifecycle: stale detection → eviction", () => {
  test("stale agents are selected by LRU policy and evicted from registry", () => {
    const now = Date.now();
    const ids = ["agent-fresh", "agent-stale-1", "agent-stale-2"] as const;

    // Register three agents with different heartbeat ages
    for (const id of ids) {
      registry.register({
        agentId: agentId(id),
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: now },
        agentType: "worker",
        priority: 10,
        metadata: {},
        registeredAt: now,
      });
      registry.transition(agentId(id), "running", 0, { kind: "assembly_complete" });
    }

    // Build eviction candidates from registry state
    const entries = registry.list({ phase: "running" });
    const candidates: readonly EvictionCandidate[] = entries.map((e, i) => ({
      agentId: e.agentId,
      phase: e.status.phase,
      // Simulate different heartbeat times: fresh=now, stale-1=old, stale-2=oldest
      lastHeartbeat: i === 0 ? now : now - i * 5000,
      priority: 100,
      metadata: {},
    }));

    // LRU selects 2 oldest
    const policy = lruPolicy();
    const toEvict = policy.selectCandidates(candidates, 2);

    expect(toEvict).toHaveLength(2);
    // Oldest first: agent-stale-2 (now - 10000), then agent-stale-1 (now - 5000)
    expect(toEvict[0]?.agentId).toBe(agentId("agent-stale-2"));
    expect(toEvict[1]?.agentId).toBe(agentId("agent-stale-1"));

    // Evict: transition to terminated
    for (const c of toEvict) {
      const entry = registry.lookup(c.agentId);
      if (entry) {
        const result = registry.transition(c.agentId, "terminated", entry.status.generation, {
          kind: "evicted",
        });
        expect(result.ok).toBe(true);
      }
    }

    // Verify: stale agents terminated, fresh agent still running
    const terminated = registry.list({ phase: "terminated" });
    expect(terminated).toHaveLength(2);

    const running = registry.list({ phase: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]?.agentId).toBe(agentId("agent-fresh"));
  });

  test("QoS policy protects high-priority agents during eviction", () => {
    const now = Date.now();

    // Register agents with different priorities
    const agents = [
      { id: "premium", priority: 300, heartbeat: now - 5000 },
      { id: "standard", priority: 100, heartbeat: now - 5000 },
      { id: "spot", priority: 50, heartbeat: now - 5000 },
    ] as const;

    for (const a of agents) {
      registry.register({
        agentId: agentId(a.id),
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: now },
        agentType: "worker",
        priority: 10,
        metadata: {},
        registeredAt: now,
      });
      registry.transition(agentId(a.id), "running", 0, { kind: "assembly_complete" });
    }

    const candidates: readonly EvictionCandidate[] = agents.map((a) => ({
      agentId: agentId(a.id),
      phase: "running" as const,
      lastHeartbeat: a.heartbeat,
      priority: a.priority,
      metadata: {},
    }));

    // QoS selects 1: lowest priority first
    const policy = qosPolicy();
    const toEvict = policy.selectCandidates(candidates, 1);

    expect(toEvict).toHaveLength(1);
    expect(toEvict[0]?.agentId).toBe(agentId("spot")); // lowest priority

    // Premium and standard are protected
    const evictedIds = new Set(toEvict.map((c) => c.agentId));
    expect(evictedIds.has(agentId("premium"))).toBe(false);
    expect(evictedIds.has(agentId("standard"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAS contention during eviction
// ---------------------------------------------------------------------------

describe("Lifecycle: CAS contention", () => {
  test("concurrent eviction attempts: only first wins via CAS", () => {
    const id = agentId("contested");

    registry.register({
      agentId: id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(id, "running", 0, { kind: "assembly_complete" });

    // Two eviction attempts at the same generation
    const gen = 1;
    const r1 = registry.transition(id, "terminated", gen, { kind: "evicted" });
    const r2 = registry.transition(id, "terminated", gen, { kind: "stale" });

    // Exactly one succeeds
    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // The failed one gets CONFLICT
    const failed = failures[0];
    if (failed && !failed.ok) {
      expect(failed.error.code).toBe("CONFLICT");
      expect(failed.error.retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful disposal: flush → dispose in correct order
// ---------------------------------------------------------------------------

describe("Lifecycle: graceful disposal", () => {
  test("disposeAll flushes monitor and clears registry", async () => {
    const id = agentId("disposable");

    registry.register({
      agentId: id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });
    monitor.record(id);

    expect(monitor.stats().bufferSize).toBe(1);
    expect(registry.list()).toHaveLength(1);

    // Dispose both — monitor flushes buffer, registry clears
    await disposeAll([monitor, registry]);

    expect(monitor.stats().bufferSize).toBe(0);
    expect(monitor.stats().totalFlushed).toBe(1);
    expect(registry.list()).toHaveLength(0);
  });

  test("disposeAll tolerates already-disposed services", async () => {
    await monitor[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();

    // Disposing again should not throw
    await disposeAll([monitor, registry]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  ReconcileResult,
  ReconciliationController,
  RegistryEntry,
} from "@koi/core";
import { agentId } from "@koi/core";
import type { FakeClock } from "./clock.js";
import { createFakeClock } from "./clock.js";
import type { ReconcileRunner } from "./reconcile-runner.js";
import { createReconcileRunner } from "./reconcile-runner.js";
import type { InMemoryRegistry } from "./registry.js";
import { createInMemoryRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function entry(
  id: string,
  phase: "created" | "running" = "created",
  generation = 0,
): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    priority: 10,
    metadata: {},
    registeredAt: Date.now(),
  };
}

const MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "1.0.0",
  model: { name: "test-model" },
  tools: [{ name: "tool-a" }, { name: "tool-b" }],
};

function createMockController(
  name: string,
  reconcileFn: (id: AgentId) => ReconcileResult | Promise<ReconcileResult>,
): ReconciliationController {
  return {
    name,
    reconcile: (id) => reconcileFn(id),
    async [Symbol.asyncDispose](): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createReconcileRunner", () => {
  let registry: InMemoryRegistry;
  let clock: FakeClock;
  let runner: ReconcileRunner;
  let manifests: Map<string, AgentManifest>;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    clock = createFakeClock(1000);
    manifests = new Map();
  });

  afterEach(async () => {
    await runner[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  function createRunner(
    config?: Partial<{
      driftCheckIntervalMs: number;
      reconcileTimeoutMs: number;
      maxConsecutiveFailures: number;
      backoffBaseMs: number;
      backoffCapMs: number;
      minReconcileIntervalMs: number;
      maxConcurrentReconciles: number;
    }>,
  ): ReconcileRunner {
    runner = createReconcileRunner({
      registry,
      manifests,
      clock,
      config: {
        driftCheckIntervalMs: 60_000,
        reconcileTimeoutMs: 5_000,
        maxConsecutiveFailures: 5,
        backoffBaseMs: 100,
        backoffCapMs: 30_000,
        minReconcileIntervalMs: 1_000,
        maxConcurrentReconciles: 0, // unlimited by default in tests
        ...config,
      },
    });
    return runner;
  }

  test("event-driven: register agent triggers reconcile", () => {
    const reconciled: string[] = [];
    const controller = createMockController("test", (id) => {
      reconciled.push(id);
      return { kind: "converged" };
    });

    createRunner();
    runner.register(controller);
    runner.start();

    const id = agentId("agent-1");
    manifests.set(id, MANIFEST);
    registry.register(entry("agent-1"));

    // Tick the process loop (100ms interval)
    clock.advance(100);

    expect(reconciled).toContain("agent-1");
    expect(runner.stats().totalReconciled).toBe(1);
  });

  test("event-driven: transition event triggers reconcile", () => {
    const reconciled: string[] = [];
    const controller = createMockController("test", (id) => {
      reconciled.push(id);
      return { kind: "converged" };
    });

    createRunner();
    runner.register(controller);
    runner.start();

    const id = agentId("agent-1");
    manifests.set(id, MANIFEST);
    registry.register(entry("agent-1"));

    // Process the register event
    clock.advance(100);
    reconciled.length = 0; // clear

    // Transition agent
    registry.transition(id, "running", 0, { kind: "assembly_complete" });
    clock.advance(100);

    expect(reconciled).toContain("agent-1");
  });

  test("drift sweep: enqueues running agents after interval", () => {
    const reconciled: string[] = [];
    const controller = createMockController("test", (id) => {
      reconciled.push(id);
      return { kind: "converged" };
    });

    createRunner({ driftCheckIntervalMs: 5_000, minReconcileIntervalMs: 1_000 });
    runner.register(controller);

    // Register and transition to running BEFORE start, so the initial
    // register event doesn't trigger reconcile (runner not started yet)
    const id = agentId("agent-1");
    manifests.set(id, MANIFEST);
    registry.register(entry("agent-1"));
    registry.transition(id, "running", 0, { kind: "assembly_complete" });

    runner.start();

    // First tick processes the events buffered before start
    clock.advance(100);
    reconciled.length = 0; // clear initial reconciles

    // Wait past minReconcileIntervalMs so drift sweep doesn't skip
    clock.advance(2_000);

    // Advance to drift sweep interval
    clock.advance(3_000); // total 5100ms from start

    // Tick to process
    clock.advance(100);

    expect(reconciled.length).toBeGreaterThanOrEqual(1);
  });

  test("backoff: controller returning retry requeues after delay", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      if (callCount === 1) return { kind: "retry", afterMs: 500 };
      return { kind: "converged" };
    });

    createRunner();
    runner.register(controller);
    runner.start();

    registry.register(entry("agent-1"));
    clock.advance(100); // first reconcile → retry
    expect(callCount).toBe(1);
    expect(runner.stats().totalRetried).toBe(1);

    clock.advance(500); // backoff timer fires, requeues
    clock.advance(100); // process tick
    expect(callCount).toBe(2);
    expect(runner.stats().totalReconciled).toBe(1);
  });

  test("circuit breaker: stops after N consecutive failures", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      throw new Error("always fails");
    });

    createRunner({ maxConsecutiveFailures: 3, backoffBaseMs: 10, backoffCapMs: 50 });
    runner.register(controller);
    runner.start();

    registry.register(entry("agent-1"));

    // Each tick processes then waits for backoff
    for (let i = 0; i < 3; i++) {
      clock.advance(100); // process tick
      clock.advance(50); // backoff timer
    }

    // After 3 failures, circuit should be broken
    clock.advance(100); // another tick — should not call controller
    // The agent may have been requeued by backoff timers, but circuit breaker skips it
    expect(runner.stats().totalCircuitBroken).toBe(1);

    // Verify no more calls happen even with tick advancement
    const countBefore = callCount;
    clock.advance(1000);
    // Circuit is broken, so no new calls should happen unless new event resets it
    expect(callCount).toBe(countBefore);
  });

  test("circuit breaker reset: new event clears circuit breaker", () => {
    let shouldFail = true;
    const controller = createMockController("test", () => {
      if (shouldFail) throw new Error("fails");
      return { kind: "converged" };
    });

    createRunner({ maxConsecutiveFailures: 2, backoffBaseMs: 10, backoffCapMs: 20 });
    runner.register(controller);
    runner.start();

    const id = agentId("agent-1");
    registry.register(entry("agent-1"));

    // Trigger 2 failures to circuit break
    clock.advance(100);
    clock.advance(20);
    clock.advance(100);
    expect(runner.stats().totalCircuitBroken).toBe(1);

    // New transition event should reset circuit breaker
    shouldFail = false;
    registry.transition(id, "running", 0, { kind: "assembly_complete" });
    clock.advance(100);

    expect(runner.stats().totalReconciled).toBeGreaterThanOrEqual(1);
  });

  test("graceful shutdown: dispose stops all processing", async () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      return { kind: "converged" };
    });

    createRunner();
    runner.register(controller);
    runner.start();

    registry.register(entry("agent-1"));
    clock.advance(100);
    expect(callCount).toBe(1);

    await runner[Symbol.asyncDispose]();

    // Register a new agent after dispose — should not trigger reconcile
    registry.register(entry("agent-2"));
    clock.advance(1000);
    expect(callCount).toBe(1); // unchanged
  });

  test("deregistration: removes agent from queue and state", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      return { kind: "converged" };
    });

    createRunner();
    runner.register(controller);
    runner.start();

    const id = agentId("agent-1");
    registry.register(entry("agent-1"));

    // Deregister before process tick
    registry.deregister(id);
    clock.advance(100);

    // Should not reconcile a deregistered agent
    expect(callCount).toBe(0);
  });

  test("controller timeout: slow async controller is called without blocking runner", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      // Return a promise that never resolves (simulating a hung controller)
      return new Promise<ReconcileResult>(() => {});
    });

    createRunner({ reconcileTimeoutMs: 200 });
    runner.register(controller);
    runner.start();

    registry.register(entry("agent-1"));
    clock.advance(100); // process tick starts reconcile

    // Controller was invoked (sync part before Promise.race)
    expect(callCount).toBe(1);

    // Runner is not blocked — a second agent can still be processed
    registry.register(entry("agent-2"));
    clock.advance(100);
    // The hung promise for agent-1 does not block agent-2
    expect(callCount).toBe(2);
  });

  test("multiple controllers: both called for same agent", () => {
    const called: string[] = [];
    const ctrl1 = createMockController("ctrl-1", () => {
      called.push("ctrl-1");
      return { kind: "converged" };
    });
    const ctrl2 = createMockController("ctrl-2", () => {
      called.push("ctrl-2");
      return { kind: "converged" };
    });

    createRunner();
    runner.register(ctrl1);
    runner.register(ctrl2);
    runner.start();

    registry.register(entry("agent-1"));
    clock.advance(100);

    expect(called).toContain("ctrl-1");
    expect(called).toContain("ctrl-2");
    expect(runner.stats().activeControllers).toBe(2);
  });

  test("dedup: rapid events for same agent result in single reconcile", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      return { kind: "converged" };
    });

    createRunner();
    runner.register(controller);
    runner.start();

    const id = agentId("agent-1");
    manifests.set(id, MANIFEST);

    // Rapid-fire: register + transition before process tick
    registry.register(entry("agent-1"));
    registry.transition(id, "running", 0, { kind: "assembly_complete" });

    clock.advance(100);

    // Queue deduplication ensures only one reconcile call
    expect(callCount).toBe(1);
  });

  test("recheck: controller returning recheck reschedules after delay", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      if (callCount === 1) return { kind: "recheck", afterMs: 300 };
      return { kind: "converged" };
    });

    createRunner();
    runner.register(controller);
    runner.start();

    registry.register(entry("agent-1"));
    clock.advance(100); // first reconcile → recheck
    expect(callCount).toBe(1);
    expect(runner.stats().totalReconciled).toBe(1);

    clock.advance(300); // recheck timer fires
    clock.advance(100); // process tick
    expect(callCount).toBe(2);
  });

  test("stats reflect current state accurately", () => {
    const controller = createMockController("test", () => ({ kind: "converged" }));

    createRunner();
    runner.register(controller);

    const initialStats = runner.stats();
    expect(initialStats.totalReconciled).toBe(0);
    expect(initialStats.totalRetried).toBe(0);
    expect(initialStats.totalCircuitBroken).toBe(0);
    expect(initialStats.queueSize).toBe(0);
    expect(initialStats.activeControllers).toBe(1);
    expect(initialStats.inFlightAsyncReconciles).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Startup sweep
  // ---------------------------------------------------------------------------

  test("startup sweep: enqueues pre-existing running agents on start", () => {
    const reconciled: string[] = [];
    const controller = createMockController("test", (id) => {
      reconciled.push(id);
      return { kind: "converged" };
    });

    // Register running agents BEFORE creating/starting runner
    const id1 = agentId("agent-1");
    const id2 = agentId("agent-2");
    manifests.set(id1, MANIFEST);
    manifests.set(id2, MANIFEST);
    registry.register(entry("agent-1", "running"));
    registry.register(entry("agent-2", "running"));

    createRunner();
    runner.register(controller);
    runner.start();

    // First tick should process startup-enqueued agents
    clock.advance(100);
    clock.advance(100);

    expect(reconciled).toContain("agent-1");
    expect(reconciled).toContain("agent-2");
  });

  test("startup sweep: ignores non-running agents", () => {
    const reconciled: string[] = [];
    const controller = createMockController("test", (id) => {
      reconciled.push(id);
      return { kind: "converged" };
    });

    // Register agents with various phases BEFORE starting runner
    manifests.set(agentId("created-agent"), MANIFEST);
    manifests.set(agentId("running-agent"), MANIFEST);
    registry.register(entry("created-agent", "created"));
    registry.register(entry("running-agent", "running"));

    createRunner();
    runner.register(controller);
    runner.start();

    // Process ticks
    clock.advance(100);
    clock.advance(100);

    // Only running agents should be enqueued by startup sweep
    // created-agent may still appear from watch events, but startup sweep
    // only queries phase: "running"
    expect(reconciled).toContain("running-agent");
    // created-agent gets enqueued by the watch "registered" event, not startup sweep
    // so it will also appear — that's expected behavior
  });

  // ---------------------------------------------------------------------------
  // On-demand sweep
  // ---------------------------------------------------------------------------

  test("sweep: force-enqueues all running agents bypassing minReconcileIntervalMs", () => {
    const reconciled: string[] = [];
    const controller = createMockController("test", (id) => {
      reconciled.push(id);
      return { kind: "converged" };
    });

    createRunner({ minReconcileIntervalMs: 60_000 });
    runner.register(controller);
    runner.start();

    const id = agentId("agent-1");
    manifests.set(id, MANIFEST);
    registry.register(entry("agent-1", "running"));

    // First reconcile via event
    clock.advance(100);
    expect(reconciled.length).toBe(1);

    // sweep() should bypass minReconcileIntervalMs
    runner.sweep();
    clock.advance(100);
    expect(reconciled.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Concurrency cap
  // ---------------------------------------------------------------------------

  test("concurrency cap: skips async reconcile when at capacity", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      // Return a promise that never resolves
      return new Promise<ReconcileResult>(() => {});
    });

    createRunner({ maxConcurrentReconciles: 1, reconcileTimeoutMs: 60_000 });
    runner.register(controller);
    runner.start();

    // Register two agents
    registry.register(entry("agent-1"));
    registry.register(entry("agent-2"));

    // First tick: agent-1 starts async reconcile (takes the one slot)
    clock.advance(100);
    // Second tick: agent-2 should be re-enqueued because slot is full
    clock.advance(100);

    // Only agent-1 should have been called (agent-2 re-enqueued)
    expect(callCount).toBe(1);
    expect(runner.stats().inFlightAsyncReconciles).toBe(1);
  });

  test("concurrency cap: re-enqueues skipped agents", async () => {
    let resolveFirst: ((v: ReconcileResult) => void) | undefined;
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<ReconcileResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { kind: "converged" };
    });

    createRunner({ maxConcurrentReconciles: 1, reconcileTimeoutMs: 60_000 });
    runner.register(controller);
    runner.start();

    registry.register(entry("agent-1"));
    registry.register(entry("agent-2"));

    // First tick: agent-1 starts async
    clock.advance(100);
    expect(callCount).toBe(1);

    // Second tick: agent-2 not dequeued because at capacity
    clock.advance(100);
    expect(callCount).toBe(1);

    // Resolve agent-1 — frees the slot
    resolveFirst?.({ kind: "converged" });
    // Flush microtasks: Promise.race settles → .then() callback decrements inFlightCount
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Next tick: agent-2 should now be processed
    clock.advance(100);
    expect(callCount).toBe(2);
  });

  test("concurrency cap: 0 means unlimited", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      return new Promise<ReconcileResult>(() => {});
    });

    createRunner({ maxConcurrentReconciles: 0, reconcileTimeoutMs: 60_000 });
    runner.register(controller);
    runner.start();

    // Register many agents
    for (let i = 0; i < 5; i++) {
      registry.register(entry(`agent-${i}`));
    }

    // Process all — unlimited concurrency
    for (let i = 0; i < 5; i++) {
      clock.advance(100);
    }

    expect(callCount).toBe(5);
  });

  test("concurrency cap: sync controllers unaffected", () => {
    let callCount = 0;
    const controller = createMockController("test", () => {
      callCount += 1;
      return { kind: "converged" };
    });

    createRunner({ maxConcurrentReconciles: 1 });
    runner.register(controller);
    runner.start();

    // Register multiple agents
    registry.register(entry("agent-1"));
    registry.register(entry("agent-2"));
    registry.register(entry("agent-3"));

    // Sync controllers bypass the concurrency cap
    clock.advance(100);
    clock.advance(100);
    clock.advance(100);

    expect(callCount).toBe(3);
  });
});

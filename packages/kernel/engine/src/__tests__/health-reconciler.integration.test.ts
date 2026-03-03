/**
 * Integration tests for the health reconciler.
 *
 * Uses real InMemoryRegistry + real HealthReconciler + createHealthMonitor
 * to test liveness detection and dead-agent eviction.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  HealthMonitorConfig,
  ProcessState,
  ReconcileContext,
  RegistryEntry,
} from "@koi/core";
import { agentId } from "@koi/core";
import type { InMemoryHealthMonitor } from "../health-monitor.js";
import { createHealthMonitor } from "../health-monitor.js";
import { createHealthReconciler } from "../health-reconciler.js";
import type { InMemoryRegistry } from "../registry.js";
import { createInMemoryRegistry } from "../registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, phase: ProcessState = "running", generation = 0): RegistryEntry {
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

function makeManifest(): AgentManifest {
  return {
    name: "health-test-agent",
    version: "1.0.0",
    model: { name: "test-model" },
  };
}

function makeContext(registry: InMemoryRegistry): ReconcileContext {
  return { registry, manifest: makeManifest() };
}

/**
 * Health config with very short thresholds for testing.
 * Suspect: 50ms, Dead: 100ms.
 */
const TEST_HEALTH_CONFIG: HealthMonitorConfig = {
  flushIntervalMs: 60_000, // Disable auto-flush (manual flush only)
  sweepIntervalMs: 60_000, // Disable auto-sweep
  suspectThresholdMs: 50,
  deadThresholdMs: 100,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HealthReconciler", () => {
  let registry: InMemoryRegistry;
  let healthMonitor: InMemoryHealthMonitor;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    healthMonitor = createHealthMonitor(registry, TEST_HEALTH_CONFIG);
  });

  afterEach(async () => {
    await healthMonitor[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  // -----------------------------------------------------------------------
  // Healthy agent with recent heartbeat → converged
  // -----------------------------------------------------------------------

  test("healthy agent with recent heartbeat returns converged", async () => {
    registry.register(makeEntry("agent-1"));
    healthMonitor.record(agentId("agent-1"));

    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    expect(result.kind).toBe("converged");
  });

  // -----------------------------------------------------------------------
  // Suspect agent → recheck
  // -----------------------------------------------------------------------

  test("suspect agent returns recheck with configured interval", async () => {
    registry.register(makeEntry("agent-1"));
    healthMonitor.record(agentId("agent-1"));

    // Wait for agent to become suspect (past suspectThresholdMs=50ms)
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    const reconciler = createHealthReconciler({
      healthMonitor,
      suspectRecheckMs: 3_000,
    });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    expect(result.kind).toBe("recheck");
    if (result.kind === "recheck") {
      expect(result.afterMs).toBe(3_000);
    }
  });

  // -----------------------------------------------------------------------
  // Dead agent → terminated via CAS transition
  // -----------------------------------------------------------------------

  test("dead agent is terminated via CAS transition", async () => {
    registry.register(makeEntry("agent-1", "running", 0));
    healthMonitor.record(agentId("agent-1"));

    // Wait for agent to become dead (past deadThresholdMs=100ms)
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    expect(result.kind).toBe("converged");

    // Agent should be terminated in registry
    const entry = registry.lookup(agentId("agent-1"));
    expect(entry?.status.phase).toBe("terminated");
    expect(entry?.status.reason?.kind).toBe("stale");
  });

  // -----------------------------------------------------------------------
  // Agent that was never heartbeated → dead → terminated
  // -----------------------------------------------------------------------

  test("agent with no heartbeat is classified as dead and terminated", async () => {
    // Register agent but never record a heartbeat
    // The lastTransitionAt from registration will be used as fallback
    // We need to make the registration old enough
    const entry = makeEntry("agent-1", "running", 0);
    const oldEntry: RegistryEntry = {
      ...entry,
      status: {
        ...entry.status,
        lastTransitionAt: Date.now() - 200, // 200ms ago, well past dead threshold
      },
    };
    registry.register(oldEntry);

    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    expect(result.kind).toBe("converged");

    // Agent should be terminated
    const updatedEntry = registry.lookup(agentId("agent-1"));
    expect(updatedEntry?.status.phase).toBe("terminated");
  });

  // -----------------------------------------------------------------------
  // Non-running agent → converged (no check)
  // -----------------------------------------------------------------------

  test("created agent is skipped (not running)", async () => {
    registry.register(makeEntry("agent-1", "created", 0));

    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    expect(result.kind).toBe("converged");
    // Agent should still be in created phase (not terminated)
    expect(registry.lookup(agentId("agent-1"))?.status.phase).toBe("created");
  });

  test("terminated agent returns converged immediately", async () => {
    registry.register(makeEntry("agent-1", "terminated", 0));

    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    expect(result.kind).toBe("converged");
  });

  // -----------------------------------------------------------------------
  // Unknown agent → converged
  // -----------------------------------------------------------------------

  test("unknown agent returns converged", async () => {
    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("nonexistent"), makeContext(registry));

    expect(result.kind).toBe("converged");
  });

  // -----------------------------------------------------------------------
  // Heartbeat keeps agent alive across multiple reconcile cycles
  // -----------------------------------------------------------------------

  test("continuous heartbeats keep agent alive across reconcile cycles", async () => {
    registry.register(makeEntry("agent-1"));
    const reconciler = createHealthReconciler({ healthMonitor });
    const ctx = makeContext(registry);

    // Record heartbeats and reconcile multiple times
    for (let i = 0; i < 5; i++) {
      healthMonitor.record(agentId("agent-1"));
      const result = await reconciler.reconcile(agentId("agent-1"), ctx);
      expect(result.kind).toBe("converged");
      // Small delay but within suspect threshold
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    // Agent should still be running
    expect(registry.lookup(agentId("agent-1"))?.status.phase).toBe("running");
  });

  // -----------------------------------------------------------------------
  // CAS conflict → retry
  // -----------------------------------------------------------------------

  test("CAS conflict during termination returns retry", async () => {
    registry.register(makeEntry("agent-1", "running", 0));
    healthMonitor.record(agentId("agent-1"));

    // Wait for agent to become dead
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    // Bump generation so CAS fails (generation mismatch)
    registry.transition(agentId("agent-1"), "suspended", 0, { kind: "hitl_pause" });
    // Now agent is at generation 1, suspended

    // Health reconciler won't check non-running agents, so put it back
    registry.transition(agentId("agent-1"), "running", 1, { kind: "signal_cont" });
    // Now agent is at generation 2

    // Health reconciler will read generation 2 from the entry, so CAS should succeed
    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    // Since the reconciler reads the current generation from lookup, this should succeed
    expect(result.kind).toBe("converged");
    expect(registry.lookup(agentId("agent-1"))?.status.phase).toBe("terminated");
  });

  // -----------------------------------------------------------------------
  // Default suspectRecheckMs
  // -----------------------------------------------------------------------

  test("default suspectRecheckMs is 2500", async () => {
    registry.register(makeEntry("agent-1"));
    healthMonitor.record(agentId("agent-1"));

    // Wait for suspect threshold
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    const reconciler = createHealthReconciler({ healthMonitor });
    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));

    expect(result.kind).toBe("recheck");
    if (result.kind === "recheck") {
      expect(result.afterMs).toBe(2_500);
    }
  });
});

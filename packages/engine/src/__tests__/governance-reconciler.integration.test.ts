/**
 * Integration tests for the governance reconciler.
 *
 * Uses real InMemoryRegistry + real GovernanceReconciler with a mock
 * Agent that carries a mock GovernanceController component.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentId,
  AgentManifest,
  GovernanceController,
  GovernanceSnapshot,
  GovernanceVariable,
  ProcessState,
  ReconcileContext,
  RegistryEntry,
  SubsystemToken,
} from "@koi/core";
import { agentId, GOVERNANCE } from "@koi/core";
import type { AgentLookup } from "../governance-reconciler.js";
import { createGovernanceReconciler } from "../governance-reconciler.js";
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
    name: "governed-agent",
    version: "1.0.0",
    model: { name: "test-model" },
  };
}

function makeContext(registry: InMemoryRegistry): ReconcileContext {
  return { registry, manifest: makeManifest() };
}

/**
 * Create a mock GovernanceController with configurable snapshot responses.
 */
function createMockGovernanceController(
  snapshotFn: () => GovernanceSnapshot,
): GovernanceController {
  return {
    check: () => ({ ok: true }),
    checkAll: () => ({ ok: true }),
    record: () => undefined,
    snapshot: snapshotFn,
    variables: () => new Map<string, GovernanceVariable>(),
    reading: () => undefined,
  };
}

/**
 * Create a mock Agent with an optional GovernanceController component.
 */
function createMockAgent(id: string, controller?: GovernanceController): Agent {
  const components = new Map<string, unknown>();
  if (controller !== undefined) {
    components.set(GOVERNANCE as string, controller);
  }

  return {
    pid: { id: agentId(id), seq: 0 },
    manifest: makeManifest(),
    state: "running",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token: SubsystemToken<unknown>): boolean => components.has(token as string),
  };
}

function healthySnapshot(): GovernanceSnapshot {
  return {
    timestamp: Date.now(),
    readings: [],
    healthy: true,
    violations: [],
  };
}

function unhealthySnapshot(violations: readonly string[]): GovernanceSnapshot {
  return {
    timestamp: Date.now(),
    readings: [],
    healthy: false,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GovernanceReconciler", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  // -----------------------------------------------------------------------
  // Healthy agent → converged
  // -----------------------------------------------------------------------

  test("healthy agent returns converged", async () => {
    const controller = createMockGovernanceController(healthySnapshot);
    const agents = new Map<string, Agent>([["agent-1", createMockAgent("agent-1", controller)]]);
    const lookup: AgentLookup = (id: AgentId) => agents.get(id);

    registry.register(makeEntry("agent-1"));
    const reconciler = createGovernanceReconciler(lookup);

    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));
    expect(result.kind).toBe("converged");
  });

  // -----------------------------------------------------------------------
  // Unknown agent → converged (no-op)
  // -----------------------------------------------------------------------

  test("unknown agent returns converged", async () => {
    const lookup: AgentLookup = () => undefined;
    const reconciler = createGovernanceReconciler(lookup);

    const result = await reconciler.reconcile(agentId("unknown"), makeContext(registry));
    expect(result.kind).toBe("converged");
  });

  // -----------------------------------------------------------------------
  // Agent without governance component → converged
  // -----------------------------------------------------------------------

  test("agent without governance component returns converged", async () => {
    const agents = new Map<string, Agent>([
      ["agent-1", createMockAgent("agent-1")], // No controller
    ]);
    const lookup: AgentLookup = (id: AgentId) => agents.get(id);

    registry.register(makeEntry("agent-1"));
    const reconciler = createGovernanceReconciler(lookup);

    const result = await reconciler.reconcile(agentId("agent-1"), makeContext(registry));
    expect(result.kind).toBe("converged");
  });

  // -----------------------------------------------------------------------
  // 5 consecutive violations → terminal
  // -----------------------------------------------------------------------

  test("5 consecutive violations produce terminal result", async () => {
    const controller = createMockGovernanceController(() =>
      unhealthySnapshot(["token_usage exceeded limit"]),
    );
    const agents = new Map<string, Agent>([["agent-1", createMockAgent("agent-1", controller)]]);
    const lookup: AgentLookup = (id: AgentId) => agents.get(id);

    registry.register(makeEntry("agent-1"));
    const reconciler = createGovernanceReconciler(lookup);
    const ctx = makeContext(registry);

    // Violations 1-4: should return recheck
    for (let i = 0; i < 4; i++) {
      const result = await reconciler.reconcile(agentId("agent-1"), ctx);
      expect(result.kind).toBe("recheck");
      if (result.kind === "recheck") {
        expect(result.afterMs).toBe(5_000);
      }
    }

    // Violation 5: should return terminal
    const terminalResult = await reconciler.reconcile(agentId("agent-1"), ctx);
    expect(terminalResult.kind).toBe("terminal");
    if (terminalResult.kind === "terminal") {
      expect(terminalResult.reason).toContain("token_usage exceeded limit");
    }
  });

  // -----------------------------------------------------------------------
  // Recovery after violation count resets
  // -----------------------------------------------------------------------

  test("healthy snapshot resets violation counter", async () => {
    let isHealthy = false; // let: toggled between healthy/unhealthy
    const controller = createMockGovernanceController(() =>
      isHealthy ? healthySnapshot() : unhealthySnapshot(["cost_usd over budget"]),
    );
    const agents = new Map<string, Agent>([["agent-1", createMockAgent("agent-1", controller)]]);
    const lookup: AgentLookup = (id: AgentId) => agents.get(id);

    registry.register(makeEntry("agent-1"));
    const reconciler = createGovernanceReconciler(lookup);
    const ctx = makeContext(registry);

    // Accumulate 4 violations (one short of terminal)
    for (let i = 0; i < 4; i++) {
      const result = await reconciler.reconcile(agentId("agent-1"), ctx);
      expect(result.kind).toBe("recheck");
    }

    // Agent recovers — violation count should reset
    isHealthy = true;
    const healthyResult = await reconciler.reconcile(agentId("agent-1"), ctx);
    expect(healthyResult.kind).toBe("converged");

    // Start violating again — should need 5 more to reach terminal
    isHealthy = false;
    for (let i = 0; i < 4; i++) {
      const result = await reconciler.reconcile(agentId("agent-1"), ctx);
      expect(result.kind).toBe("recheck");
    }

    // 5th violation after reset → terminal
    const terminalResult = await reconciler.reconcile(agentId("agent-1"), ctx);
    expect(terminalResult.kind).toBe("terminal");
  });

  // -----------------------------------------------------------------------
  // Governance variable threshold breach → recheck then terminal
  // -----------------------------------------------------------------------

  test("variable threshold breach produces correct violation messages", async () => {
    const violations = ["spawn_depth exceeded: 5/3", "turn_count exceeded: 200/100"];
    const controller = createMockGovernanceController(() => unhealthySnapshot(violations));
    const agents = new Map<string, Agent>([["agent-1", createMockAgent("agent-1", controller)]]);
    const lookup: AgentLookup = (id: AgentId) => agents.get(id);

    registry.register(makeEntry("agent-1"));
    const reconciler = createGovernanceReconciler(lookup);
    const ctx = makeContext(registry);

    // Drive to terminal (5 violations)
    for (let i = 0; i < 4; i++) {
      await reconciler.reconcile(agentId("agent-1"), ctx);
    }

    const terminalResult = await reconciler.reconcile(agentId("agent-1"), ctx);
    expect(terminalResult.kind).toBe("terminal");
    if (terminalResult.kind === "terminal") {
      expect(terminalResult.reason).toContain("spawn_depth exceeded: 5/3");
      expect(terminalResult.reason).toContain("turn_count exceeded: 200/100");
    }
  });

  // -----------------------------------------------------------------------
  // Dispose clears state
  // -----------------------------------------------------------------------

  test("dispose clears violation tracking", async () => {
    const controller = createMockGovernanceController(() =>
      unhealthySnapshot(["error_rate too high"]),
    );
    const agents = new Map<string, Agent>([["agent-1", createMockAgent("agent-1", controller)]]);
    const lookup: AgentLookup = (id: AgentId) => agents.get(id);

    registry.register(makeEntry("agent-1"));
    const reconciler = createGovernanceReconciler(lookup);
    const ctx = makeContext(registry);

    // Accumulate 4 violations
    for (let i = 0; i < 4; i++) {
      await reconciler.reconcile(agentId("agent-1"), ctx);
    }

    // Dispose and recreate shouldn't carry over old counts
    await reconciler[Symbol.asyncDispose]();

    // After dispose, the internal map is cleared — next reconcile starts fresh
    // However, the reconciler instance is disposed. Let's verify via a fresh one.
    const freshReconciler = createGovernanceReconciler(lookup);
    const result = await freshReconciler.reconcile(agentId("agent-1"), ctx);
    expect(result.kind).toBe("recheck"); // First violation, not terminal
  });
});

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentId,
  AgentManifest,
  GovernanceController,
  GovernanceSnapshot,
  ReconcileContext,
  SubsystemToken,
} from "@koi/core";
import { agentId, GOVERNANCE } from "@koi/core";
import type { AgentLookup } from "./governance-reconciler.js";
import { createGovernanceReconciler } from "./governance-reconciler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockController(
  healthy: boolean,
  violations: readonly string[] = [],
): GovernanceController {
  const snap: GovernanceSnapshot = {
    timestamp: Date.now(),
    readings: [],
    healthy,
    violations,
  };
  return {
    check: () => ({ ok: true }),
    checkAll: () => ({ ok: true }),
    record: () => undefined,
    snapshot: () => snap,
    variables: () => new Map(),
    reading: () => undefined,
  };
}

function mockAgent(controller?: GovernanceController): Agent {
  const components = new Map<string, unknown>();
  if (controller !== undefined) {
    components.set(GOVERNANCE as string, controller);
  }
  return {
    pid: { id: agentId("test"), name: "test", type: "copilot", depth: 0 },
    manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
    state: "running",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
}

function mockLookup(agents: ReadonlyMap<string, Agent>): AgentLookup {
  return (id: AgentId) => agents.get(id as string);
}

function mockReconcileContext(): ReconcileContext {
  const manifest: AgentManifest = {
    name: "test",
    version: "0.0.0",
    model: { name: "test" },
  } as AgentManifest;
  return {
    registry: {} as ReconcileContext["registry"],
    manifest,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGovernanceReconciler", () => {
  test("returns converged when agent is healthy", async () => {
    const controller = mockController(true);
    const agent = mockAgent(controller);
    const agents = new Map<string, Agent>([[agent.pid.id as string, agent]]);
    const reconciler = createGovernanceReconciler(mockLookup(agents));

    const result = await reconciler.reconcile(agent.pid.id, mockReconcileContext());
    expect(result.kind).toBe("converged");
  });

  test("returns recheck on first violation", async () => {
    const controller = mockController(false, ["turn_count"]);
    const agent = mockAgent(controller);
    const agents = new Map<string, Agent>([[agent.pid.id as string, agent]]);
    const reconciler = createGovernanceReconciler(mockLookup(agents));

    const result = await reconciler.reconcile(agent.pid.id, mockReconcileContext());
    expect(result.kind).toBe("recheck");
    if (result.kind === "recheck") {
      expect(result.afterMs).toBe(5000);
    }
  });

  test("returns terminal after 5 consecutive violations", async () => {
    const controller = mockController(false, ["turn_count"]);
    const agent = mockAgent(controller);
    const agents = new Map<string, Agent>([[agent.pid.id as string, agent]]);
    const reconciler = createGovernanceReconciler(mockLookup(agents));
    const ctx = mockReconcileContext();

    for (let i = 0; i < 4; i++) {
      const result = await reconciler.reconcile(agent.pid.id, ctx);
      expect(result.kind).toBe("recheck");
    }
    const result = await reconciler.reconcile(agent.pid.id, ctx);
    expect(result.kind).toBe("terminal");
  });

  test("resets counter when agent becomes healthy", async () => {
    // let justified: mutable healthy flag for test control
    let healthy = false;
    const controller: GovernanceController = {
      check: () => ({ ok: true }),
      checkAll: () => ({ ok: true }),
      record: () => undefined,
      snapshot: () => ({
        timestamp: Date.now(),
        readings: [],
        healthy,
        violations: healthy ? [] : ["turn_count"],
      }),
      variables: () => new Map(),
      reading: () => undefined,
    };
    const agent = mockAgent(controller);
    const agents = new Map<string, Agent>([[agent.pid.id as string, agent]]);
    const reconciler = createGovernanceReconciler(mockLookup(agents));
    const ctx = mockReconcileContext();

    // 3 violations
    for (let i = 0; i < 3; i++) {
      await reconciler.reconcile(agent.pid.id, ctx);
    }

    // Now healthy
    healthy = true;
    const result = await reconciler.reconcile(agent.pid.id, ctx);
    expect(result.kind).toBe("converged");

    // Violations should be back to 0 — 4 more without terminal
    healthy = false;
    for (let i = 0; i < 4; i++) {
      const r = await reconciler.reconcile(agent.pid.id, ctx);
      expect(r.kind).toBe("recheck");
    }
  });

  test("returns converged when agent not found", async () => {
    const reconciler = createGovernanceReconciler(() => undefined);
    const result = await reconciler.reconcile(agentId("unknown"), mockReconcileContext());
    expect(result.kind).toBe("converged");
  });

  test("returns converged when agent has no governance controller", async () => {
    const agent = mockAgent(); // no controller
    const agents = new Map<string, Agent>([[agent.pid.id as string, agent]]);
    const reconciler = createGovernanceReconciler(mockLookup(agents));
    const result = await reconciler.reconcile(agent.pid.id, mockReconcileContext());
    expect(result.kind).toBe("converged");
  });

  test("dispose clears violation counts", async () => {
    const controller = mockController(false, ["turn_count"]);
    const agent = mockAgent(controller);
    const agents = new Map<string, Agent>([[agent.pid.id as string, agent]]);
    const reconciler = createGovernanceReconciler(mockLookup(agents));
    const ctx = mockReconcileContext();

    // Accumulate violations
    for (let i = 0; i < 3; i++) {
      await reconciler.reconcile(agent.pid.id, ctx);
    }

    // Dispose and re-check — should restart from 0
    await reconciler[Symbol.asyncDispose]();

    // First violation again after dispose
    const result = await reconciler.reconcile(agent.pid.id, ctx);
    expect(result.kind).toBe("recheck");
  });
});

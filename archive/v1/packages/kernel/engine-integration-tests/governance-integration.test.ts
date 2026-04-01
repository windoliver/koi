/**
 * Integration tests for the unified governance controller.
 *
 * Exercises the full assembly → extension → middleware pipeline:
 *   1. GovernanceProvider attaches builder
 *   2. GovernanceExtension discovers L2 contributors via prefix query
 *   3. Extension seals builder and produces governance guard middleware
 *   4. Guard enforces turn/token/spawn limits in the middleware chain
 */

import { describe, expect, test } from "bun:test";
import type {
  GovernanceController,
  GovernanceVariableContributor,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SubsystemToken,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import {
  agentId,
  GOVERNANCE,
  GOVERNANCE_VARIABLES,
  governanceContributorToken,
  runId,
  sessionId,
  turnId,
} from "@koi/core";
import type { GovernanceControllerBuilder } from "@koi/engine-reconcile";
import {
  createGovernanceExtension,
  createGovernanceProvider,
  createGovernanceReconciler,
} from "@koi/engine-reconcile";
import { KoiRuntimeError } from "@koi/errors";
import { AgentEntity } from "../src/agent-entity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testPid(depth = 0): import("@koi/core").ProcessId {
  return { id: agentId("integ-test"), name: "integ", type: "copilot" as const, depth };
}

function testManifest(): import("@koi/core").AgentManifest {
  return {
    name: "integ-agent",
    version: "0.1.0",
    model: { name: "test-model" },
  } as import("@koi/core").AgentManifest;
}

function mockTurnContext(): TurnContext {
  const rid = runId("r1");
  return {
    session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function getOnBeforeTurn(mw: KoiMiddleware): (ctx: TurnContext) => Promise<void> {
  if (mw.onBeforeTurn === undefined) throw new Error("onBeforeTurn missing");
  return mw.onBeforeTurn;
}

function getWrapToolCall(
  mw: KoiMiddleware,
): (
  ctx: TurnContext,
  req: ToolRequest,
  next: (r: ToolRequest) => Promise<ToolResponse>,
) => Promise<ToolResponse> {
  if (mw.wrapToolCall === undefined) throw new Error("wrapToolCall missing");
  return mw.wrapToolCall;
}

function getWrapModelCall(
  mw: KoiMiddleware,
): (
  ctx: TurnContext,
  req: ModelRequest,
  next: (r: ModelRequest) => Promise<ModelResponse>,
) => Promise<ModelResponse> {
  if (mw.wrapModelCall === undefined) throw new Error("wrapModelCall missing");
  return mw.wrapModelCall;
}

// ---------------------------------------------------------------------------
// Assembly integration
// ---------------------------------------------------------------------------

describe("governance integration", () => {
  test("assembly: provider attaches builder as GOVERNANCE component", async () => {
    const provider = createGovernanceProvider({ iteration: { maxTurns: 10 } });
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider]);

    expect(agent.has(GOVERNANCE)).toBe(true);
    const builder = agent.component<GovernanceControllerBuilder>(
      GOVERNANCE as SubsystemToken<GovernanceControllerBuilder>,
    );
    expect(builder).toBeDefined();
    expect(builder?.sealed).toBe(false);
    // Built-in variables registered
    expect(builder?.variables().has(GOVERNANCE_VARIABLES.SPAWN_DEPTH)).toBe(true);
    expect(builder?.variables().has(GOVERNANCE_VARIABLES.TURN_COUNT)).toBe(true);
    expect(builder?.variables().has(GOVERNANCE_VARIABLES.ERROR_RATE)).toBe(true);
  });

  test("extension discovers L2 contributors via prefix query", async () => {
    const contributorToken = governanceContributorToken("test-l2");
    const testContributor: GovernanceVariableContributor = {
      variables: () => [
        {
          name: "test_sensor",
          read: () => 42,
          limit: 100,
          retryable: false,
          description: "Test sensor for integration",
          check: () => ({ ok: true }),
        },
      ],
    };

    const governanceProvider = createGovernanceProvider();
    const l2Provider = {
      name: "test-l2-governance",
      async attach(): Promise<ReadonlyMap<string, unknown>> {
        return new Map([[contributorToken as string, testContributor]]);
      },
    };

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [
      governanceProvider,
      l2Provider,
    ]);

    // Verify contributor is discoverable
    const contributors = agent.query<GovernanceVariableContributor>("governance:contrib:");
    expect(contributors.size).toBe(1);

    // Run extension guards — discovers and registers contributor
    const ext = createGovernanceExtension();
    const guards = ext.guards?.({
      agentDepth: 0,
      manifest: testManifest(),
      components: agent.components(),
      agent,
    });

    expect(guards).toHaveLength(1);

    // Builder is now sealed with the contributor's variable registered
    const builder = agent.component<GovernanceControllerBuilder>(
      GOVERNANCE as SubsystemToken<GovernanceControllerBuilder>,
    );
    expect(builder?.sealed).toBe(true);
    expect(builder?.variables().has("test_sensor")).toBe(true);

    // Verify the sensor reading
    const reading = builder?.reading("test_sensor");
    expect(reading).toBeDefined();
    expect(reading?.current).toBe(42);
    expect(reading?.limit).toBe(100);
  });

  test("guard denies turns when limit is reached", async () => {
    const governanceProvider = createGovernanceProvider({
      iteration: { maxTurns: 3 },
    });
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [governanceProvider]);

    const ext = createGovernanceExtension();
    const guards = ext.guards?.({
      agentDepth: 0,
      manifest: testManifest(),
      components: agent.components(),
      agent,
    });

    const guard = guards[0];
    expect(guard).toBeDefined();
    const onBeforeTurn = getOnBeforeTurn(guard as KoiMiddleware);
    const ctx = mockTurnContext();

    // First 3 turns: record + check — turn 1 ok, turn 2 ok, turn 3 fails (3 >= 3)
    await onBeforeTurn(ctx); // turn 1
    await onBeforeTurn(ctx); // turn 2
    await expect(onBeforeTurn(ctx)).rejects.toThrow(KoiRuntimeError); // turn 3 hits limit
  });

  test("guard tracks token usage via wrapModelCall", async () => {
    const governanceProvider = createGovernanceProvider({
      iteration: { maxTokens: 100 },
    });
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [governanceProvider]);

    const ext = createGovernanceExtension();
    const guards = ext.guards?.({
      agentDepth: 0,
      manifest: testManifest(),
      components: agent.components(),
      agent,
    });

    const guard = guards[0];
    expect(guard).toBeDefined();
    const wrapModelCall = getWrapModelCall(guard as KoiMiddleware);
    const ctx = mockTurnContext();

    const fakeResponse: ModelResponse = {
      content: "test",
      model: "test-model",
      usage: { inputTokens: 20, outputTokens: 30 },
    };

    // First model call: 50 tokens recorded
    await wrapModelCall(ctx, { messages: [] } as ModelRequest, async () => fakeResponse);

    // Second model call: 50 more → 100 total
    await wrapModelCall(ctx, { messages: [] } as ModelRequest, async () => fakeResponse);

    // Verify token reading
    const builder = agent.component<GovernanceController>(GOVERNANCE);
    const reading = builder?.reading(GOVERNANCE_VARIABLES.TOKEN_USAGE);
    expect(reading?.current).toBe(100);
  });

  test("guard tracks tool errors and successes", async () => {
    const governanceProvider = createGovernanceProvider();
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [governanceProvider]);

    const ext = createGovernanceExtension();
    const guards = ext.guards?.({
      agentDepth: 0,
      manifest: testManifest(),
      components: agent.components(),
      agent,
    });

    const guard = guards[0];
    expect(guard).toBeDefined();
    const wrapToolCall = getWrapToolCall(guard as KoiMiddleware);
    const ctx = mockTurnContext();

    const request: ToolRequest = { toolId: "my_tool", input: {} };

    // Successful call
    await wrapToolCall(ctx, request, async () => ({ output: "ok" }));

    // Failed call
    try {
      await wrapToolCall(ctx, request, async () => {
        throw new Error("tool failure");
      });
    } catch {
      // expected
    }

    // Snapshot reflects the activity
    const builder = agent.component<GovernanceController>(GOVERNANCE);
    const snap = await builder?.snapshot();
    const errorReading = snap?.readings.find((r) => r.name === GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(errorReading).toBeDefined();
    // 1 error out of 2 total = 0.5
    expect(errorReading?.current).toBe(0.5);
  });

  test("snapshot shows correct readings and violations after events", async () => {
    const governanceProvider = createGovernanceProvider({
      iteration: { maxTurns: 5, maxTokens: 1000 },
    });
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [governanceProvider]);

    const ext = createGovernanceExtension();
    ext.guards?.({
      agentDepth: 0,
      manifest: testManifest(),
      components: agent.components(),
      agent,
    });

    const builder = agent.component<GovernanceController>(GOVERNANCE);
    expect(builder).toBeDefined();

    // Record some events directly on the controller
    builder?.record({ kind: "turn" });
    builder?.record({ kind: "turn" });
    builder?.record({ kind: "token_usage", count: 250 });

    const snap = await builder?.snapshot();
    expect(snap?.healthy).toBe(true);

    const turnReading = snap?.readings.find((r) => r.name === GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(turnReading?.current).toBe(2);
    expect(turnReading?.limit).toBe(5);
    expect(turnReading?.utilization).toBeCloseTo(0.4);

    const tokenReading = snap?.readings.find((r) => r.name === GOVERNANCE_VARIABLES.TOKEN_USAGE);
    expect(tokenReading?.current).toBe(250);
    expect(tokenReading?.utilization).toBeCloseTo(0.25);
  });

  test("spawn depth check reflects assembly depth", async () => {
    // Agent at depth 3 with max depth 2 → spawn_depth check fails
    const governanceProvider = createGovernanceProvider({
      spawn: { maxDepth: 2 },
    });
    const { agent } = await AgentEntity.assemble(
      testPid(3), // depth=3
      testManifest(),
      [governanceProvider],
    );

    const ext = createGovernanceExtension();
    ext.guards?.({
      agentDepth: 3,
      manifest: testManifest(),
      components: agent.components(),
      agent,
    });

    const builder = agent.component<GovernanceController>(GOVERNANCE);
    expect(builder).toBeDefined();
    const check = await builder?.check(GOVERNANCE_VARIABLES.SPAWN_DEPTH);
    expect(check?.ok).toBe(false);
    if (check !== undefined && !check.ok) {
      expect(check.variable).toBe(GOVERNANCE_VARIABLES.SPAWN_DEPTH);
      expect(check.retryable).toBe(false);
    }
  });

  test("reconciler detects persistent violations and returns terminal", async () => {
    const governanceProvider = createGovernanceProvider({
      iteration: { maxTurns: 1 },
    });
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [governanceProvider]);

    // Seal the builder via extension
    const ext = createGovernanceExtension();
    ext.guards?.({
      agentDepth: 0,
      manifest: testManifest(),
      components: agent.components(),
      agent,
    });

    // Put agent in violation state (record 1 turn to exhaust limit)
    const controller = agent.component<GovernanceController>(GOVERNANCE);
    expect(controller).toBeDefined();
    controller?.record({ kind: "turn" });

    // AgentLookup resolves agentId → Agent
    const agents = new Map<string, import("@koi/core").Agent>([[agent.pid.id as string, agent]]);
    const agentLookup = (id: import("@koi/core").AgentId) => agents.get(id as string);

    const reconciler = createGovernanceReconciler(agentLookup);
    const ctx = {
      registry: {} as import("@koi/core").ReconcileContext["registry"],
      manifest: testManifest(),
    };

    // First 4 reconcile calls: "recheck"
    for (let i = 0; i < 4; i++) {
      const result = await reconciler.reconcile?.(agent.pid.id, ctx);
      expect(result.kind).toBe("recheck");
    }

    // 5th call: terminal
    const result = await reconciler.reconcile?.(agent.pid.id, ctx);
    expect(result.kind).toBe("terminal");
  });
});

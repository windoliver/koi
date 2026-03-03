import { describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  GovernanceVariable,
  GovernanceVariableContributor,
  GuardContext,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SubsystemToken,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId, GOVERNANCE, GOVERNANCE_VARIABLES, runId, sessionId, turnId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { GovernanceControllerBuilder } from "./governance-controller.js";
import { createGovernanceController } from "./governance-controller.js";
import { createGovernanceExtension } from "./governance-extension.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAgent(
  builder: GovernanceControllerBuilder,
  contributors?: ReadonlyMap<
    SubsystemToken<GovernanceVariableContributor>,
    GovernanceVariableContributor
  >,
): Agent {
  const components = new Map<string, unknown>();
  components.set(GOVERNANCE as string, builder);
  if (contributors !== undefined) {
    for (const [key, value] of contributors) {
      components.set(key as string, value);
    }
  }
  return {
    pid: { id: agentId("test"), name: "test", type: "copilot", depth: 0 },
    manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
    state: "created",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: <T>(prefix: string) => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: () => components,
  };
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
// Tests
// ---------------------------------------------------------------------------

describe("createGovernanceExtension", () => {
  test("produces guard middleware when GOVERNANCE builder is present", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController();
    const agent = mockAgent(builder);
    const ctx: GuardContext = {
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    };
    const guards = await ext.guards?.(ctx);
    expect(guards).toBeDefined();
    expect(guards).toHaveLength(1);
    const firstGuard = guards?.[0];
    expect(firstGuard?.name).toBe("koi:governance-guard");
    expect(builder.sealed).toBe(true);
  });

  test("returns empty when no GOVERNANCE component", async () => {
    const ext = createGovernanceExtension();
    const agent: Agent = {
      pid: { id: agentId("test"), name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };
    const ctx: GuardContext = {
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    };
    const guards = await ext.guards?.(ctx);
    expect(guards).toHaveLength(0);
  });

  test("discovers and registers contributor variables", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController();

    const customVar: GovernanceVariable = {
      name: "custom_depth",
      read: () => 1,
      limit: 5,
      retryable: false,
      check: () => ({ ok: true }),
    };
    const contributor: GovernanceVariableContributor = {
      variables: () => [customVar],
    };
    const contribMap = new Map<
      SubsystemToken<GovernanceVariableContributor>,
      GovernanceVariableContributor
    >();
    contribMap.set(
      "governance:contrib:test" as SubsystemToken<GovernanceVariableContributor>,
      contributor,
    );

    const agent = mockAgent(builder, contribMap);
    const ctx: GuardContext = {
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    };
    await ext.guards?.(ctx);

    expect(builder.variables().has("custom_depth")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Governance guard middleware behavior
  // -------------------------------------------------------------------------

  test("guard onBeforeTurn records turn and checks limits", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController({
      iteration: { maxTurns: 2, maxTokens: 100000, maxDurationMs: 300000 },
    });
    const agent = mockAgent(builder);
    const guardList = await ext.guards?.({
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    });
    expect(guardList).toBeDefined();
    const guard = guardList?.[0];
    if (guard === undefined) throw new Error("guard not found");
    const ctx = mockTurnContext();

    // First onBeforeTurn: records turn 1, checks (1 < 2) → ok
    await getOnBeforeTurn(guard)(ctx);
    // Second onBeforeTurn: records turn 2, checks (2 >= 2) → TIMEOUT
    await expect(getOnBeforeTurn(guard)(ctx)).rejects.toThrow(KoiRuntimeError);
  });

  test("guard wrapToolCall tracks spawn tools", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController({
      spawn: { maxDepth: 3, maxFanOut: 1 },
    });
    const agent = mockAgent(builder);
    const guardList = await ext.guards?.({
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    });
    expect(guardList).toBeDefined();
    const guard = guardList?.[0];
    if (guard === undefined) throw new Error("guard not found");
    const ctx = mockTurnContext();
    const next = mock(() => Promise.resolve({ output: "ok" } as ToolResponse));

    // First spawn — ok
    await getWrapToolCall(guard)(ctx, { toolId: "forge_agent", input: {} }, next);

    // Need to record spawn event manually (governance guard doesn't auto-increment spawn count)
    builder.record({ kind: "spawn", depth: 1 });

    // Second spawn — should fail (count 1 >= maxFanOut 1)
    await expect(
      getWrapToolCall(guard)(ctx, { toolId: "forge_agent", input: {} }, next),
    ).rejects.toThrow(KoiRuntimeError);
  });

  test("guard wrapToolCall records success on non-spawn tools", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController();
    const agent = mockAgent(builder);
    const guardList = await ext.guards?.({
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    });
    expect(guardList).toBeDefined();
    const guard = guardList?.[0];
    if (guard === undefined) throw new Error("guard not found");
    const ctx = mockTurnContext();
    const next = mock(() => Promise.resolve({ output: "ok" } as ToolResponse));

    await getWrapToolCall(guard)(ctx, { toolId: "some_tool", input: {} }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("guard wrapToolCall records error on tool failure", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController();
    const agent = mockAgent(builder);
    const guardList = await ext.guards?.({
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    });
    expect(guardList).toBeDefined();
    const guard = guardList?.[0];
    if (guard === undefined) throw new Error("guard not found");
    const ctx = mockTurnContext();
    const next = mock(() => Promise.reject(new Error("tool failed")));

    await expect(
      getWrapToolCall(guard)(ctx, { toolId: "some_tool", input: {} }, next),
    ).rejects.toThrow("tool failed");
  });

  test("guard wrapModelCall records token usage", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController({
      iteration: { maxTurns: 25, maxTokens: 100, maxDurationMs: 300000 },
    });
    const agent = mockAgent(builder);
    const guardList = await ext.guards?.({
      agentDepth: 0,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
      components: agent.components(),
      agent,
    });
    expect(guardList).toBeDefined();
    const guard = guardList?.[0];
    if (guard === undefined) throw new Error("guard not found");
    const ctx = mockTurnContext();
    const next = mock(() =>
      Promise.resolve({
        content: "ok",
        model: "test",
        usage: { inputTokens: 30, outputTokens: 20 },
      } as ModelResponse),
    );

    await getWrapModelCall(guard)(ctx, { messages: [] }, next);
    const reading = builder.reading(GOVERNANCE_VARIABLES.TOKEN_USAGE);
    expect(reading?.current).toBe(50);
  });

  // -------------------------------------------------------------------------
  // Assembly validation
  // -------------------------------------------------------------------------

  test("validateAssembly passes when no GOVERNANCE component", async () => {
    const ext = createGovernanceExtension();
    const result = await ext.validateAssembly?.(new Map(), {
      name: "test",
      version: "0.0.0",
      model: { name: "test" },
    });
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
  });

  test("validateAssembly passes for valid GovernanceController", async () => {
    const ext = createGovernanceExtension();
    const builder = createGovernanceController();
    const components = new Map<string, unknown>();
    components.set(GOVERNANCE as string, builder);
    const result = await ext.validateAssembly?.(components, {
      name: "test",
      version: "0.0.0",
      model: { name: "test" },
    });
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
  });

  test("validateAssembly fails for invalid GOVERNANCE component", async () => {
    const ext = createGovernanceExtension();
    const components = new Map<string, unknown>();
    components.set(GOVERNANCE as string, { notAController: true });
    const result = await ext.validateAssembly?.(components, {
      name: "test",
      version: "0.0.0",
      model: { name: "test" },
    });
    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
  });
});

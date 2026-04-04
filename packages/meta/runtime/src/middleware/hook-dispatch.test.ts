import { describe, expect, mock, test } from "bun:test";
import type {
  HookDecision,
  HookExecutionResult,
  JsonObject,
  RichTrajectoryStep,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { HookDispatchConfig } from "./hook-dispatch.js";
import { createHookDispatchMiddleware } from "./hook-dispatch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnCtx(overrides?: Partial<TurnContext>): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "sid" as never,
      runId: "rid" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "tid" as never,
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function successResult(
  hookName: string,
  decision: HookDecision = { kind: "continue" },
): HookExecutionResult {
  return { ok: true, hookName, durationMs: 1, decision };
}

function failedResult(hookName: string, error: string): HookExecutionResult {
  return { ok: false, hookName, error, durationMs: 1 };
}

function createMockStore(): {
  readonly steps: RichTrajectoryStep[];
  readonly store: {
    readonly append: (docId: string, steps: readonly RichTrajectoryStep[]) => Promise<void>;
  };
} {
  const steps: RichTrajectoryStep[] = [];
  return {
    steps,
    store: {
      append: async (_docId: string, newSteps: readonly RichTrajectoryStep[]) => {
        steps.push(...newSteps);
      },
    },
  };
}

function createConfig(
  overrides: Partial<HookDispatchConfig> & {
    readonly executeResult?: readonly HookExecutionResult[];
  } = {},
): { readonly config: HookDispatchConfig; readonly steps: RichTrajectoryStep[] } {
  const { steps, store } = createMockStore();
  const executeResult = overrides.executeResult ?? [];

  const registry = {
    register: () => {},
    execute: mock(async () => executeResult),
    cleanup: () => {},
  };

  return {
    steps,
    config: {
      hooks: [],
      store: store as never,
      docId: "test-doc",
      registry,
      registrySessionId: "sid",
      ...overrides,
    },
  };
}

/** Filter and return the first hook_execution step's metadata decision field. */
function getHookDecision(steps: readonly RichTrajectoryStep[]): unknown {
  const hookSteps = steps.filter((s) => (s.metadata as JsonObject)?.type === "hook_execution");
  expect(hookSteps.length).toBeGreaterThanOrEqual(1);
  const meta = hookSteps[0]?.metadata as JsonObject;
  return meta.decision;
}

// ---------------------------------------------------------------------------
// B1: Hook decision metadata in trajectory steps
// ---------------------------------------------------------------------------

describe("hook-dispatch decision metadata", () => {
  test("continue decision appears in metadata", async () => {
    const { config, steps } = createConfig({
      executeResult: [successResult("my-hook", { kind: "continue" })],
    });
    const mw = createHookDispatchMiddleware(config);

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });
    await mw.wrapToolCall?.(makeTurnCtx(), { toolId: "test-tool", input: {} } as never, next);

    expect(getHookDecision(steps)).toEqual({ kind: "continue" });
  });

  test("block decision includes reason in metadata", async () => {
    const { config, steps } = createConfig({
      executeResult: [successResult("guard", { kind: "block", reason: "not allowed" })],
    });
    const mw = createHookDispatchMiddleware(config);

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });
    await expect(
      mw.wrapToolCall?.(makeTurnCtx(), { toolId: "test-tool", input: {} } as never, next),
    ).rejects.toThrow("Hook blocked tool test-tool");

    expect(getHookDecision(steps)).toEqual({
      kind: "block",
      reason: "not allowed",
    });
  });

  test("modify decision includes patch in metadata", async () => {
    const patch = { safe: true, level: 2 };
    const { config, steps } = createConfig({
      executeResult: [successResult("sanitizer", { kind: "modify", patch })],
    });
    const mw = createHookDispatchMiddleware(config);

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });
    await mw.wrapToolCall?.(makeTurnCtx(), { toolId: "test-tool", input: {} } as never, next);

    expect(getHookDecision(steps)).toEqual({ kind: "modify", patch });
  });

  test("transform decision includes outputPatch in metadata", async () => {
    const outputPatch = { redacted: true };
    const { config, steps } = createConfig({
      executeResult: [successResult("transformer", { kind: "transform", outputPatch })],
    });
    const mw = createHookDispatchMiddleware(config);

    // transform is only used for post-call hooks, but the recording happens
    // for all hooks. In pre-call context, transform is treated as continue.
    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });
    await mw.wrapToolCall?.(makeTurnCtx(), { toolId: "test-tool", input: {} } as never, next);

    expect(getHookDecision(steps)).toEqual({ kind: "transform", outputPatch });
  });

  test("failed hook appears with error decision in metadata", async () => {
    const { config, steps } = createConfig({
      executeResult: [failedResult("broken-hook", "timeout exceeded")],
    });
    const mw = createHookDispatchMiddleware(config);

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });
    await expect(
      mw.wrapToolCall?.(makeTurnCtx(), { toolId: "test-tool", input: {} } as never, next),
    ).rejects.toThrow();

    expect(getHookDecision(steps)).toEqual({
      kind: "error",
      reason: "timeout exceeded",
    });
  });
});

// ---------------------------------------------------------------------------
// B3: Stop-gate block recording in onAfterTurn
// ---------------------------------------------------------------------------

describe("hook-dispatch stop-gate recording", () => {
  test("records stop-gate block step with outcome retry on stopBlocked turn", async () => {
    const { config, steps } = createConfig();
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(
      makeTurnCtx({
        stopBlocked: true,
        stopGateReason: "tests not passing",
        stopGateBlockedBy: "quality-gate",
        turnIndex: 2,
      }),
    );

    const gateSteps = steps.filter(
      (s) => (s.metadata as JsonObject)?.type === "stop_gate_decision",
    );
    expect(gateSteps).toHaveLength(1);

    const step = gateSteps[0];
    expect(step?.outcome).toBe("retry");
    expect(step?.identifier).toBe("stop-gate:block");
    expect(step?.source).toBe("system");

    const meta = step?.metadata as JsonObject;
    expect(meta.blockedBy).toBe("quality-gate");
    expect(meta.reason).toBe("tests not passing");
    expect(meta.turnIndex).toBe(2);
  });

  test("does not record stop-gate step for normal turns", async () => {
    const { config, steps } = createConfig({
      executeResult: [successResult("turn-observer")],
    });
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(makeTurnCtx());

    const gateSteps = steps.filter(
      (s) => (s.metadata as JsonObject)?.type === "stop_gate_decision",
    );
    expect(gateSteps).toHaveLength(0);
  });

  test("skips turn.ended dispatch for stop-gate vetoed turns", async () => {
    const { config } = createConfig();
    const registry = config.registry;
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(makeTurnCtx({ stopBlocked: true, stopGateReason: "blocked" }));

    // turn.ended should NOT have been dispatched (only stop-gate recording)
    expect(registry?.execute).not.toHaveBeenCalled();
  });
});

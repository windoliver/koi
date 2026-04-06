import { describe, expect, test } from "bun:test";
import type {
  HookDecision,
  HookEvent,
  HookExecutionResult,
  JsonObject,
  RichTrajectoryStep,
  TurnContext,
} from "@koi/core";
import { createHookObserver } from "./hook-dispatch.js";

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

function makeEvent(event: string, toolName?: string): HookEvent {
  return {
    event,
    agentId: "test-agent",
    sessionId: "sid",
    ...(toolName !== undefined ? { toolName } : {}),
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
// B1: onExecuted tap records decision metadata in ATIF trajectory steps
// ---------------------------------------------------------------------------

describe("hook-observer decision metadata", () => {
  test("continue decision appears in metadata", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted(
      [successResult("my-hook", { kind: "continue" })],
      makeEvent("tool.succeeded", "test-tool"),
    );

    expect(getHookDecision(steps)).toEqual({ kind: "continue" });
  });

  test("block decision includes reason in metadata", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted(
      [successResult("guard", { kind: "block", reason: "not allowed" })],
      makeEvent("tool.before", "test-tool"),
    );

    expect(getHookDecision(steps)).toEqual({
      kind: "block",
      reasonLength: "not allowed".length,
    });
  });

  test("modify decision includes patch in metadata", () => {
    const patch = { safe: true, level: 2 };
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted(
      [successResult("sanitizer", { kind: "modify", patch })],
      makeEvent("tool.before", "test-tool"),
    );

    expect(getHookDecision(steps)).toEqual({
      kind: "modify",
      patch: { fieldCount: 2, fields: { safe: "boolean", level: "number" } },
    });
  });

  test("transform decision includes outputPatch in metadata", () => {
    const outputPatch = { result: "redacted", items: [1, 2] };
    const metadata = { source: "redaction" };
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted(
      [successResult("redactor", { kind: "transform", outputPatch, metadata })],
      makeEvent("tool.succeeded", "test-tool"),
    );

    expect(getHookDecision(steps)).toEqual({
      kind: "transform",
      outputPatch: { fieldCount: 2, fields: { result: "string", items: "array(2)" } },
      metadata: { fieldCount: 1, fields: { source: "string" } },
    });
  });

  test("failed hook appears with error decision in metadata", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted(
      [failedResult("broken-hook", "connection refused")],
      makeEvent("tool.before", "test-tool"),
    );

    expect(getHookDecision(steps)).toEqual({
      kind: "error",
      reasonLength: "connection refused".length,
    });
  });

  test("empty results do not produce ATIF steps", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([], makeEvent("tool.before", "test-tool"));

    expect(steps).toHaveLength(0);
  });

  test("no store configured — onExecuted is a no-op", () => {
    const { onExecuted } = createHookObserver({});

    // Should not throw
    onExecuted([successResult("my-hook")], makeEvent("tool.before", "test-tool"));
  });

  test("trigger event is taken from HookEvent.event field", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([successResult("my-hook")], makeEvent("tool.failed", "test-tool"));

    const hookSteps = steps.filter((s) => (s.metadata as JsonObject)?.type === "hook_execution");
    expect(hookSteps).toHaveLength(1);
    expect((hookSteps[0]?.metadata as JsonObject).triggerEvent).toBe("tool.failed");
  });
});

// ---------------------------------------------------------------------------
// B2: Stop-gate ATIF recording via middleware.onAfterTurn
// ---------------------------------------------------------------------------

describe("hook-observer stop-gate recording", () => {
  test("records stop-gate block step with outcome retry on stopBlocked turn", async () => {
    const { steps, store } = createMockStore();
    const { middleware } = createHookObserver({ store: store as never, docId: "test-doc" });

    const ctx = makeTurnCtx({
      stopBlocked: true,
      stopGateBlockedBy: "human-review",
      stopGateReason: "needs approval",
    });
    await middleware.onAfterTurn?.(ctx);

    expect(steps).toHaveLength(1);
    const step = steps[0] as (typeof steps)[0];
    expect(step.identifier).toBe("stop-gate:block");
    expect(step.outcome).toBe("retry");
    const meta = step.metadata as JsonObject;
    expect(meta.type).toBe("stop_gate_decision");
    expect(meta.blockedBy).toBe("human-review");
    expect(meta.reasonLength).toBe("needs approval".length);
  });

  test("does not record stop-gate step for normal turns", async () => {
    const { steps, store } = createMockStore();
    const { middleware } = createHookObserver({ store: store as never, docId: "test-doc" });

    await middleware.onAfterTurn?.(makeTurnCtx());

    expect(steps).toHaveLength(0);
  });

  test("stop-gate uses 'unknown' when stopGateBlockedBy is absent", async () => {
    const { steps, store } = createMockStore();
    const { middleware } = createHookObserver({ store: store as never, docId: "test-doc" });

    const ctx = makeTurnCtx({ stopBlocked: true });
    await middleware.onAfterTurn?.(ctx);

    expect(steps).toHaveLength(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.blockedBy).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// B3: Error truncation
// ---------------------------------------------------------------------------

describe("hook-observer error detail in trajectory", () => {
  test("short hook error is preserved in full", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([failedResult("h", "short error")], makeEvent("tool.before"));

    const step = steps[0] as (typeof steps)[0];
    expect(step.error).toEqual({ text: "short error" });
  });

  test("long hook error is truncated with originalSize metadata", () => {
    const longError = "x".repeat(600);
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([failedResult("h", longError)], makeEvent("tool.before"));

    expect(steps).toHaveLength(1);
    const step = steps[0] as (typeof steps)[0];
    expect(step.error?.text?.length).toBe(512);
    expect(step.error?.truncated).toBe(true);
    expect(step.error?.originalSize).toBeGreaterThan(512);
  });

  test("error at exactly max length is not truncated", () => {
    const exactError = "a".repeat(512);
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([failedResult("h", exactError)], makeEvent("tool.before"));

    expect(steps).toHaveLength(1);
    const step = steps[0] as (typeof steps)[0];
    expect(step.error).toEqual({ text: exactError });
  });

  test("truncation does not split a surrogate pair", () => {
    const emoji = "\uD83D\uDE00"; // U+1F600 — 4-byte char
    const padding = "a".repeat(510);
    const errorWithSurrogateAtBoundary = `${padding}${emoji}end`;
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([failedResult("h", errorWithSurrogateAtBoundary)], makeEvent("tool.before"));

    expect(steps).toHaveLength(1);
    const step = steps[0] as (typeof steps)[0];
    // High surrogate at position 510, truncation backs up to 510
    expect(step.error?.text?.length).toBeLessThanOrEqual(512);
    expect(step.error?.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B4: Middleware metadata
// ---------------------------------------------------------------------------

describe("hook-observer middleware metadata", () => {
  test("middleware has correct name, phase, and priority", () => {
    const { middleware } = createHookObserver({});
    expect(middleware.name).toBe("hook-observer");
    expect(middleware.phase).toBe("observe");
    expect(middleware.priority).toBe(950);
  });

  test("describeCapabilities returns observer label", () => {
    const { middleware } = createHookObserver({});
    const cap = middleware.describeCapabilities?.({} as never);
    expect(cap?.label).toBe("Hook Observer");
  });

  test("middleware has no wrapToolCall", () => {
    const { middleware } = createHookObserver({});
    expect(middleware.wrapToolCall).toBeUndefined();
  });

  test("middleware has no wrapModelCall", () => {
    const { middleware } = createHookObserver({});
    expect(middleware.wrapModelCall).toBeUndefined();
  });

  test("middleware has no wrapModelStream", () => {
    const { middleware } = createHookObserver({});
    expect(middleware.wrapModelStream).toBeUndefined();
  });

  test("middleware has no onSessionStart", () => {
    const { middleware } = createHookObserver({});
    expect(middleware.onSessionStart).toBeUndefined();
  });

  test("middleware has no onSessionEnd", () => {
    const { middleware } = createHookObserver({});
    expect(middleware.onSessionEnd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B5: Multi-result and step metadata
// ---------------------------------------------------------------------------

describe("hook-observer multi-result recording", () => {
  test("multiple hook results produce multiple ATIF steps", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted(
      [
        successResult("hook-a", { kind: "continue" }),
        successResult("hook-b", { kind: "block", reason: "denied" }),
      ],
      makeEvent("tool.before", "test-tool"),
    );

    expect(steps).toHaveLength(2);
    expect((steps[0] as (typeof steps)[0]).identifier).toBe("hook:hook-a");
    expect((steps[1] as (typeof steps)[0]).identifier).toBe("hook:hook-b");
  });

  test("successful hook has outcome 'success'", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([successResult("h")], makeEvent("tool.before"));

    expect((steps[0] as (typeof steps)[0]).outcome).toBe("success");
  });

  test("failed hook has outcome 'failure'", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([failedResult("h", "boom")], makeEvent("tool.before"));

    expect((steps[0] as (typeof steps)[0]).outcome).toBe("failure");
  });

  test("step includes durationMs from hook result", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    const result: HookExecutionResult = {
      ok: true,
      hookName: "h",
      durationMs: 42,
      decision: { kind: "continue" },
    };
    onExecuted([result], makeEvent("tool.before"));

    expect((steps[0] as (typeof steps)[0]).durationMs).toBe(42);
  });

  test("step source is 'system' and kind is 'model_call'", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    onExecuted([successResult("h")], makeEvent("tool.before"));

    const step = steps[0] as (typeof steps)[0];
    expect(step.source).toBe("system");
    expect(step.kind).toBe("model_call");
  });

  test("executionFailed flag is propagated to decision metadata", () => {
    const { steps, store } = createMockStore();
    const { onExecuted } = createHookObserver({ store: store as never, docId: "test-doc" });

    const result: HookExecutionResult = {
      ok: true,
      hookName: "h",
      durationMs: 1,
      decision: { kind: "continue" },
      executionFailed: true,
    };
    onExecuted([result], makeEvent("tool.before"));

    const meta = (steps[0] as (typeof steps)[0]).metadata as JsonObject;
    expect((meta.decision as JsonObject).executionFailed).toBe(true);
  });
});

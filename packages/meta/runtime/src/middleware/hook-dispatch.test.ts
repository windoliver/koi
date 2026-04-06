import { describe, expect, mock, test } from "bun:test";
import type {
  HookDecision,
  HookEvent,
  HookExecutionResult,
  JsonObject,
  RichTrajectoryStep,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { HookDispatchConfig, HookRegistryLike } from "./hook-dispatch.js";
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
      reasonLength: "not allowed".length,
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

    expect(getHookDecision(steps)).toEqual({
      kind: "modify",
      patch: { fieldCount: 2, fields: { safe: "boolean", level: "number" } },
    });
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

    expect(getHookDecision(steps)).toEqual({
      kind: "transform",
      outputPatch: { fieldCount: 1, fields: { redacted: "boolean" } },
    });
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
      reasonLength: "timeout exceeded".length,
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
    expect(meta.reasonLength).toBe("tests not passing".length);
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

// ---------------------------------------------------------------------------
// Regression: registry dispatch must key on live ctx.session.sessionId, not a
// static configured id. Once-hook consumption must be scoped per session, so
// a single middleware instance reused across sessions (or configured for
// "session-A" hooks but called with "session-B" context) cannot suppress
// hooks belonging to another session. See issue #1490.
// ---------------------------------------------------------------------------

describe("hook-dispatch registry session isolation (issue #1490)", () => {
  /**
   * Fake registry that tracks per-session once-hook consumption. Mirrors the
   * real HookRegistry contract: hooks registered per sessionId, once-hooks
   * consumed on first execute() for that session only.
   */
  function createFakeRegistry(onceHookName: string): {
    readonly registry: HookRegistryLike;
    readonly executeCalls: Array<{
      readonly sessionId: string;
      readonly eventSessionId: string;
      readonly hadSignal: boolean;
    }>;
  } {
    const consumed = new Set<string>(); // sessionIds that already consumed the once-hook
    const executeCalls: Array<{
      readonly sessionId: string;
      readonly eventSessionId: string;
      readonly hadSignal: boolean;
    }> = [];
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async (sessionId, event, abortSignal) => {
        executeCalls.push({
          sessionId,
          eventSessionId: event.sessionId,
          hadSignal: abortSignal !== undefined,
        });
        if (consumed.has(sessionId)) {
          return [];
        }
        consumed.add(sessionId);
        return [
          {
            ok: true,
            hookName: onceHookName,
            durationMs: 1,
            decision: { kind: "continue" },
          } satisfies HookExecutionResult,
        ];
      },
      cleanup: () => {},
    };
    return { registry, executeCalls };
  }

  test("once-hook fires once per session, not once per middleware instance", async () => {
    const { registry, executeCalls } = createFakeRegistry("greeter");
    const mw = createHookDispatchMiddleware({
      hooks: [],
      registry,
    });

    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });

    // Session A — fires once (pre) and is now consumed for session A.
    await mw.wrapToolCall?.(
      makeTurnCtx({
        session: {
          agentId: "a",
          sessionId: "session-A" as never,
          runId: "r" as never,
          metadata: {},
        },
      }),
      { toolId: "t", input: {} } as never,
      next,
    );
    // Session B — must still fire once, because consumption is per-session.
    await mw.wrapToolCall?.(
      makeTurnCtx({
        session: {
          agentId: "a",
          sessionId: "session-B" as never,
          runId: "r" as never,
          metadata: {},
        },
      }),
      { toolId: "t", input: {} } as never,
      next,
    );

    // Each wrapToolCall fires tool.before + tool.succeeded → 2 dispatches per session.
    // Both session keys must appear, proving the middleware keyed on the live
    // ctx.session.sessionId instead of a static configured id.
    const sessionsCalled = new Set(executeCalls.map((c) => c.sessionId));
    expect(sessionsCalled).toEqual(new Set(["session-A", "session-B"]));

    // Event payload sessionId must match the session key (no static override).
    for (const call of executeCalls) {
      expect(call.eventSessionId).toBe(call.sessionId);
    }

    // The once-hook must have fired exactly once per session (2 sessions → 2 results).
    // If the middleware had keyed on a static id, session B would get [] instead.
    const firedCount = executeCalls.filter(
      (c) => c.sessionId === "session-A" || c.sessionId === "session-B",
    ).length;
    // Session A: tool.before fires once (consumes), tool.succeeded returns [].
    // Session B: tool.before fires once (consumes), tool.succeeded returns [].
    // So total execute calls = 4, but "first call per session" is what matters.
    expect(firedCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Regression: per-call abort signal must propagate on both direct and
// registry dispatch paths, so a canceled tool call or turn aborts hook
// execution promptly rather than running to completion. See issue #1490.
// ---------------------------------------------------------------------------

describe("hook-dispatch cancellation propagation (issue #1490)", () => {
  test("registry path forwards ctx.signal to registry.execute", async () => {
    // let justified: mutable — captures signals received across dispatches
    const capturedSignals: (AbortSignal | undefined)[] = [];
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async (_sid, _event, abortSignal) => {
        capturedSignals.push(abortSignal);
        return [];
      },
      cleanup: () => {},
    };

    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    const controller = new AbortController();
    const ctx = makeTurnCtx({ signal: controller.signal });
    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next);

    // Both pre and post dispatches must receive the ctx.signal.
    expect(capturedSignals.length).toBeGreaterThanOrEqual(1);
    for (const sig of capturedSignals) {
      expect(sig).toBe(controller.signal);
    }
  });

  test("wrapToolCall fails closed when ctx.signal is already aborted (direct path)", async () => {
    // An already-aborted signal must abort the tool call before any hook
    // dispatch. Otherwise a canceled turn could bypass fail-closed hooks
    // whose registry short-circuited on the aborted signal, and run the
    // tool under "continue" as if no hooks existed.
    const mw = createHookDispatchMiddleware({ hooks: [] });

    const controller = new AbortController();
    controller.abort();
    const ctx = makeTurnCtx({ signal: controller.signal });
    // let justified: mutable — set only if next() is wrongly reached
    let nextWasCalled = false;
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      nextWasCalled = true;
      return { output: "ok" };
    };

    await expect(mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next)).rejects.toThrow(
      /aborted/,
    );
    expect(nextWasCalled).toBe(false);
  });

  test("registry execute receives undefined signal when ctx.signal is absent and no session signal configured", async () => {
    // let justified: mutable — captures signals received across dispatches
    const capturedSignals: (AbortSignal | undefined)[] = [];
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async (_sid, _event, abortSignal) => {
        capturedSignals.push(abortSignal);
        return [];
      },
      cleanup: () => {},
    };

    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    // ctx without a signal → registry should receive undefined, not a stale signal.
    const ctx = makeTurnCtx();
    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next);

    expect(capturedSignals.length).toBeGreaterThanOrEqual(1);
    for (const sig of capturedSignals) {
      expect(sig).toBeUndefined();
    }
  });

  test("aborted ctx.signal fails closed on registry path without calling registry.execute", async () => {
    // Regression for adversarial-review finding: if the signal is already
    // aborted, we must NOT dispatch through the registry and fall through
    // to `next()`. Empty registry results would otherwise be aggregated as
    // "continue" and bypass fail-closed pre-hooks. The correct behavior is
    // to abort the tool call before the registry is touched.
    const executeSpy = mock(async () => [] as readonly HookExecutionResult[]);
    const registry: HookRegistryLike = {
      register: () => {},
      execute: executeSpy,
      cleanup: () => {},
    };
    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    const controller = new AbortController();
    controller.abort();
    const ctx = makeTurnCtx({ signal: controller.signal });
    // let justified: mutable — tracked to assert tool never ran
    let nextWasCalled = false;
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      nextWasCalled = true;
      return { output: "ok" };
    };

    await expect(mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next)).rejects.toThrow(
      /aborted/,
    );
    expect(nextWasCalled).toBe(false);
    // The middleware must not have invoked the registry once cancellation
    // was observed — otherwise its short-circuit would have mutated state.
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test("signal aborting DURING pre-hook dispatch aborts the tool call", async () => {
    // Mid-flight cancellation path: the registry returns [] because the
    // signal aborted while hooks were executing. The middleware must NOT
    // fall through and call next() — that would bypass fail-closed hooks.
    const controller = new AbortController();
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async (_sid, _event, abortSignal) => {
        // Flip the signal mid-dispatch then return empty (simulating the
        // registry's cancellation short-circuit).
        controller.abort();
        expect(abortSignal?.aborted).toBe(true);
        return [];
      },
      cleanup: () => {},
    };
    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    const ctx = makeTurnCtx({ signal: controller.signal });
    // let justified: mutable — verifies tool never ran
    let nextWasCalled = false;
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      nextWasCalled = true;
      return { output: "ok" };
    };

    await expect(mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next)).rejects.toThrow(
      /aborted/,
    );
    expect(nextWasCalled).toBe(false);
  });

  test("late abort does NOT redact tool output when no post-hook candidates are configured", async () => {
    // Regression: the cancellation-redaction guard must only fire when
    // post-hooks could actually have been skipped. If the middleware has
    // no hooks at all (or only pre-hooks), a late caller abort is not
    // bypassing any fail-closed contract and must return the raw output.
    const controller = new AbortController();
    const mw = createHookDispatchMiddleware({ hooks: [] });

    const ctx = makeTurnCtx({ signal: controller.signal });
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      // Abort AFTER the tool returns — simulates late cancellation.
      controller.abort();
      return { output: "PLAIN_RESULT" };
    };

    const result = await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next);
    expect(result?.output).toBe("PLAIN_RESULT");
    expect((result?.metadata as JsonObject)?.committedButRedacted).toBeUndefined();
  });

  test("late abort does NOT redact when only fail-open post-hooks match", async () => {
    // Regression: hooks configured `failClosed: false` explicitly opt out
    // of output suppression on failure. Late-abort redaction must not
    // override that intent — if the only matching post-hook is fail-open,
    // the raw output passes through on cancel.
    const controller = new AbortController();
    const mw = createHookDispatchMiddleware({
      hooks: [
        {
          kind: "command",
          name: "observer",
          cmd: ["echo"],
          filter: { events: ["tool.succeeded"] },
          failClosed: false, // fail-open: do NOT suppress output
        },
      ],
    });

    const ctx = makeTurnCtx({ signal: controller.signal });
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      controller.abort();
      return { output: "PLAIN_FAIL_OPEN" };
    };

    const result = await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next);
    expect(result?.output).toBe("PLAIN_FAIL_OPEN");
    expect((result?.metadata as JsonObject)?.committedButRedacted).toBeUndefined();
  });

  test("late abort does NOT redact when post-hooks are filtered to OTHER tools", async () => {
    // Regression: hasPostHookFor must be per-call. If a post-hook is
    // filtered to a different tool, a late abort on this tool's call
    // bypasses no contract and must return the raw output.
    const controller = new AbortController();
    const mw = createHookDispatchMiddleware({
      hooks: [
        {
          kind: "command",
          name: "audit-other",
          cmd: ["echo"],
          filter: { events: ["tool.succeeded"], tools: ["other-tool"] },
        },
      ],
    });

    const ctx = makeTurnCtx({ signal: controller.signal });
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      controller.abort();
      return { output: "PLAIN_FOR_THIS_TOOL" };
    };

    const result = await mw.wrapToolCall?.(ctx, { toolId: "this-tool", input: {} } as never, next);
    expect(result?.output).toBe("PLAIN_FOR_THIS_TOOL");
    expect((result?.metadata as JsonObject)?.committedButRedacted).toBeUndefined();
  });

  test("registry with has(): unregistered session does NOT redact on late abort", async () => {
    // Regression: hasPostHookFor on the registry path must use registry.has()
    // when available. An unregistered session has no hooks the registry
    // could dispatch, so redaction would be unnecessary data-loss.
    const controller = new AbortController();
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async () => [],
      cleanup: () => {},
      has: () => false, // session not registered
    };
    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    const ctx = makeTurnCtx({ signal: controller.signal });
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      controller.abort();
      return { output: "PLAIN_UNREGISTERED" };
    };

    const result = await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next);
    expect(result?.output).toBe("PLAIN_UNREGISTERED");
    expect((result?.metadata as JsonObject)?.committedButRedacted).toBeUndefined();
  });

  test("non-empty post-hook results take precedence — no double-redaction on late abort", async () => {
    // Regression: if post-hooks DID run and returned results, the abort
    // check must not redact on top of that. checkPostHookFailures handles
    // their decisions; redacting here would corrupt successful tool output
    // when an abort arrives right after post-hooks completed.
    const controller = new AbortController();
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async (_sid, event, _signal) => {
        if (event.event === "tool.before") return [];
        // Post-hook ran successfully, THEN caller aborts.
        const result: readonly HookExecutionResult[] = [
          { ok: true, hookName: "audit", durationMs: 1, decision: { kind: "continue" } },
        ];
        controller.abort();
        return result;
      },
      cleanup: () => {},
      has: () => true,
    };
    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    const ctx = makeTurnCtx({ signal: controller.signal });
    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({
      output: "POST_HOOK_RAN_SUCCESSFULLY",
    });

    const result = await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next);
    // Post-hook returned continue, so the raw output should pass through.
    expect(result?.output).toBe("POST_HOOK_RAN_SUCCESSFULLY");
    expect((result?.metadata as JsonObject)?.committedButRedacted).toBeUndefined();
  });

  test("late abort during post-hook dispatch redacts tool output (fail-closed)", async () => {
    // Regression: if the caller cancels AFTER the tool succeeded but BEFORE
    // post-hooks run, registry.execute() returns [] on the aborted signal.
    // Returning raw output in that case bypasses fail-closed post-hooks
    // (output redaction, audit). Tool side effects are already committed,
    // so the only safe behavior is to redact defensively.
    const controller = new AbortController();
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async (_sid, event, _abortSignal) => {
        if (event.event === "tool.before") {
          // Pre-hook runs normally — tool should execute.
          return [];
        }
        // Post-hook: caller cancels, registry short-circuits.
        controller.abort();
        return [];
      },
      cleanup: () => {},
    };
    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    const ctx = makeTurnCtx({ signal: controller.signal });
    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({
      output: "SENSITIVE_RAW_DATA",
    });

    const result = await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} } as never, next);
    // Must be redacted, not the raw tool output.
    expect(result?.output).toContain("redacted");
    expect(result?.output).not.toContain("SENSITIVE_RAW_DATA");
    expect((result?.metadata as JsonObject)?.committedButRedacted).toBe(true);
  });

  test("event sessionId matches the live ctx.session.sessionId for dispatches", async () => {
    // let justified: mutable — captures the event payloads dispatched
    const capturedEvents: HookEvent[] = [];
    const registry: HookRegistryLike = {
      register: () => {},
      execute: async (_sid, event) => {
        capturedEvents.push(event);
        return [];
      },
      cleanup: () => {},
    };
    const mw = createHookDispatchMiddleware({ hooks: [], registry });

    await mw.onAfterTurn?.(
      makeTurnCtx({
        session: {
          agentId: "a",
          sessionId: "live-session-123" as never,
          runId: "r" as never,
          metadata: {},
        },
      }),
    );

    expect(capturedEvents.length).toBe(1);
    expect(capturedEvents[0]?.sessionId).toBe("live-session-123");
    expect(capturedEvents[0]?.event).toBe("turn.ended");
  });
});

// ---------------------------------------------------------------------------
// Issue #1501: Stop-gate retries must not block on trajectory storage
// ---------------------------------------------------------------------------

describe("hook-dispatch fire-and-forget store writes (#1501)", () => {
  test("stop-gate store write does not block onAfterTurn return", async () => {
    // Store that never resolves — if awaited, onAfterTurn would hang forever.
    let appendCalled = false;
    const hangingStore = {
      append: (_docId: string, _steps: readonly RichTrajectoryStep[]) => {
        appendCalled = true;
        return new Promise<void>(() => {}); // never resolves
      },
    };

    const mw = createHookDispatchMiddleware({
      hooks: [],
      store: hangingStore as never,
      docId: "test-doc",
    });

    // If fire-and-forget works, this resolves immediately despite hanging store
    await mw.onAfterTurn?.(makeTurnCtx({ stopBlocked: true, stopGateBlockedBy: "quality-gate" }));

    expect(appendCalled).toBe(true);
  });

  test("recordHookResults store write does not block turn.ended path", async () => {
    let appendCalled = false;
    const hangingStore = {
      append: (_docId: string, _steps: readonly RichTrajectoryStep[]) => {
        appendCalled = true;
        return new Promise<void>(() => {}); // never resolves
      },
    };

    const registry = {
      register: () => {},
      execute: mock(async () => [successResult("observer")]),
      cleanup: () => {},
    };

    const mw = createHookDispatchMiddleware({
      hooks: [],
      store: hangingStore as never,
      docId: "test-doc",
      registry,
    });

    // If fire-and-forget works, this resolves immediately despite hanging store
    await mw.onAfterTurn?.(makeTurnCtx());

    expect(appendCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #1501: Hook error traces must preserve actionable error detail
// ---------------------------------------------------------------------------

describe("hook-dispatch error detail in trajectory (#1501)", () => {
  test("short hook error is preserved in full", async () => {
    const errorMsg = "auth token expired";
    const { config, steps } = createConfig({
      executeResult: [failedResult("auth-check", errorMsg)],
    });
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(makeTurnCtx());

    const hookSteps = steps.filter((s) => (s.metadata as JsonObject)?.type === "hook_execution");
    expect(hookSteps).toHaveLength(1);
    expect(hookSteps[0]?.error?.text).toBe(errorMsg);
    expect(hookSteps[0]?.error?.truncated).toBeUndefined();
  });

  test("long hook error is truncated with originalSize metadata", async () => {
    const longError = "x".repeat(1000);
    const { config, steps } = createConfig({
      executeResult: [failedResult("crash-hook", longError)],
    });
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(makeTurnCtx());

    const hookSteps = steps.filter((s) => (s.metadata as JsonObject)?.type === "hook_execution");
    expect(hookSteps).toHaveLength(1);

    const err = hookSteps[0]?.error;
    expect(err?.text).toHaveLength(512);
    expect(err?.text).toBe(longError.slice(0, 512));
    expect(err?.truncated).toBe(true);
    expect(err?.originalSize).toBe(1000);
  });

  test("originalSize reports byte size for non-ASCII errors", async () => {
    // "ñ" is 2 UTF-8 bytes but 1 UTF-16 code unit
    const nonAscii = "ñ".repeat(1000); // 1000 .length, 2000 bytes
    const { config, steps } = createConfig({
      executeResult: [failedResult("intl-hook", nonAscii)],
    });
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(makeTurnCtx());

    const hookSteps = steps.filter((s) => (s.metadata as JsonObject)?.type === "hook_execution");
    const err = hookSteps[0]?.error;
    expect(err?.truncated).toBe(true);
    // originalSize should be byte size (2000), not .length (1000)
    expect(err?.originalSize).toBe(new TextEncoder().encode(nonAscii).byteLength);
    expect(err?.originalSize).toBe(2000);
  });

  test("error at exactly max length is not truncated", async () => {
    const exactError = "e".repeat(512);
    const { config, steps } = createConfig({
      executeResult: [failedResult("edge-hook", exactError)],
    });
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(makeTurnCtx());

    const hookSteps = steps.filter((s) => (s.metadata as JsonObject)?.type === "hook_execution");
    expect(hookSteps[0]?.error?.text).toBe(exactError);
    expect(hookSteps[0]?.error?.truncated).toBeUndefined();
  });

  test("truncation does not split a surrogate pair", async () => {
    // Build a string where char at index 511 is a high surrogate
    const prefix = "a".repeat(511);
    const emoji = "\u{1F600}"; // surrogate pair: 2 UTF-16 code units
    const longError = prefix + emoji + "b".repeat(500);
    const { config, steps } = createConfig({
      executeResult: [failedResult("surrogate-hook", longError)],
    });
    const mw = createHookDispatchMiddleware(config);

    await mw.onAfterTurn?.(makeTurnCtx());

    const hookSteps = steps.filter((s) => (s.metadata as JsonObject)?.type === "hook_execution");
    const text = hookSteps[0]?.error?.text ?? "";
    // Should back up to avoid splitting: 511 chars (not 512 with broken surrogate)
    expect(text).toHaveLength(511);
    expect(text).toBe(prefix);
    // Verify no lone surrogate in output
    expect(text.endsWith(prefix)).toBe(true);
  });
});

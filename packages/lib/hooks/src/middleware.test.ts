/**
 * Middleware dispatch tests — verifies that createHookMiddleware correctly
 * bridges hook execution into the KoiMiddleware lifecycle.
 *
 * Uses mocked executors (spyOn executeHooks) since the executor itself is
 * already tested in hook-lifecycle.test.ts. These tests focus on:
 *   1. Lifecycle dispatch (session start/end, turn start/end) + block enforcement
 *   2. Tool wrapping with decision aggregation
 *   3. Model wrapping (call + stream) with decision aggregation
 *   4. Fail-open on hook execution failure
 *   5. Model patch allowlist safety
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type {
  HookConfig,
  HookDecision,
  HookEvent,
  HookExecutionResult,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  RunId,
  SessionContext,
  SessionId,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import * as executorModule from "./executor.js";
import { aggregateDecisions, aggregatePostDecisions, createHookMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HOOKS: readonly HookConfig[] = [
  {
    kind: "command",
    name: "on-tool-pre",
    cmd: ["echo", "ok"],
    filter: { events: ["tool.before"] },
  },
  {
    kind: "http",
    name: "on-session",
    url: "https://example.com/hook",
    filter: { events: ["session.started", "session.ended"] },
  },
];

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: "session-1" as SessionId,
    runId: "run-1" as RunId,
    metadata: {},
    ...overrides,
  };
}

function makeTurnCtx(overrides?: Partial<TurnContext>): TurnContext {
  return {
    session: makeSessionCtx(),
    turnIndex: 0,
    turnId: "turn-1" as TurnId,
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

function failureResult(hookName: string, error: string): HookExecutionResult {
  return { ok: false, hookName, error, durationMs: 1 };
}

/** Type-narrowing assertion — fails the test if value is undefined. */
function assertDefined<T>(value: T | undefined): asserts value is T {
  expect(value).toBeDefined();
}

/**
 * Helper: register session with continue decision, then set the spy to
 * return the given results for subsequent calls.
 */
async function startSessionThen(
  mw: ReturnType<typeof createHookMiddleware>,
  spy: ReturnType<typeof spyOn>,
  thenResults: readonly HookExecutionResult[],
): Promise<void> {
  spy.mockResolvedValue([]);
  await mw.onSessionStart?.(makeSessionCtx());
  spy.mockResolvedValue(thenResults);
}

/** Collect all chunks from an async iterable. */
async function collectChunks(stream: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// aggregateDecisions unit tests
// ---------------------------------------------------------------------------

describe("aggregateDecisions", () => {
  it("returns continue when all hooks continue", () => {
    const result = aggregateDecisions([successResult("a"), successResult("b")]);
    expect(result.decision).toEqual({ kind: "continue" });
  });

  it("returns block when any hook blocks (most restrictive wins)", () => {
    const result = aggregateDecisions([
      successResult("a"),
      successResult("b", { kind: "block", reason: "not allowed" }),
      successResult("c", { kind: "modify", patch: { x: 1 } }),
    ]);
    expect(result.decision).toEqual({ kind: "block", reason: "not allowed" });
  });

  it("merges modify patches when multiple hooks modify", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "modify", patch: { x: 1 } }),
      successResult("b", { kind: "modify", patch: { y: 2 } }),
    ]);
    expect(result.decision).toEqual({ kind: "modify", patch: { x: 1, y: 2 } });
  });

  it("later modify patches override earlier keys", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "modify", patch: { x: 1 } }),
      successResult("b", { kind: "modify", patch: { x: 99 } }),
    ]);
    expect(result.decision).toEqual({ kind: "modify", patch: { x: 99 } });
  });

  it("ignores failed hooks (fail-open)", () => {
    const result = aggregateDecisions([failureResult("broken", "timeout"), successResult("ok")]);
    expect(result.decision).toEqual({ kind: "continue" });
  });

  it("returns continue for empty results", () => {
    const result = aggregateDecisions([]);
    expect(result.decision).toEqual({ kind: "continue" });
  });

  it("merges transform outputPatch from multiple hooks (later overrides earlier)", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "transform", outputPatch: { x: 1, y: 2 } }),
      successResult("b", { kind: "transform", outputPatch: { y: 99, z: 3 } }),
    ]);
    // transform is post-call only — ignored in pre-call aggregation
    expect(result.decision).toEqual({ kind: "continue" });
  });

  it("ignores transform metadata in pre-call aggregation", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "transform", outputPatch: { x: 1 }, metadata: { ctx: "a" } }),
    ]);
    // transform is post-call only — ignored in pre-call aggregation
    expect(result.decision).toEqual({ kind: "continue" });
  });

  it("block wins even with transform present", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "transform", outputPatch: { x: 1 } }),
      successResult("b", { kind: "block", reason: "denied" }),
    ]);
    expect(result.decision).toEqual({ kind: "block", reason: "denied" });
  });

  it("modify applies when transform is also present (transform ignored pre-call)", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "modify", patch: { x: 1 } }),
      successResult("b", { kind: "transform", outputPatch: { y: 2 } }),
    ]);
    expect(result.decision).toEqual({ kind: "modify", patch: { x: 1 } });
  });

  it("returns hookName of blocking hook", () => {
    const result = aggregateDecisions([
      successResult("observer"),
      successResult("quota-guard", { kind: "block", reason: "over limit" }),
    ]);
    expect(result.hookName).toBe("quota-guard");
  });

  it("returns undefined hookName for modify", () => {
    const result = aggregateDecisions([
      successResult("rerouter", { kind: "modify", patch: { model: "cheap" } }),
    ]);
    expect(result.hookName).toBeUndefined();
  });

  it("returns undefined hookName for continue", () => {
    const result = aggregateDecisions([successResult("observer")]);
    expect(result.hookName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// aggregatePostDecisions unit tests
// ---------------------------------------------------------------------------

describe("aggregatePostDecisions", () => {
  it("ignores block decisions (tool already executed)", () => {
    const result = aggregatePostDecisions([
      successResult("a", { kind: "block", reason: "too late" }),
      successResult("b", { kind: "transform", outputPatch: { redacted: true } }),
    ]);
    expect(result).toEqual({ kind: "transform", outputPatch: { redacted: true } });
  });

  it("ignores modify decisions post-execution", () => {
    const result = aggregatePostDecisions([
      successResult("a", { kind: "modify", patch: { x: 1 } }),
    ]);
    expect(result).toEqual({ kind: "continue" });
  });

  it("merges multiple transforms", () => {
    const result = aggregatePostDecisions([
      successResult("a", { kind: "transform", outputPatch: { x: 1 } }),
      successResult("b", { kind: "transform", outputPatch: { y: 2 }, metadata: { source: "b" } }),
    ]);
    expect(result).toEqual({
      kind: "transform",
      outputPatch: { x: 1, y: 2 },
      metadata: { source: "b" },
    });
  });

  it("returns continue when all hooks succeed with no transforms", () => {
    const result = aggregatePostDecisions([successResult("a"), successResult("b")]);
    expect(result).toEqual({ kind: "continue" });
  });

  it("returns block when any hook fails (signals taint to middleware)", () => {
    const result = aggregatePostDecisions([successResult("a"), failureResult("broken", "timeout")]);
    expect(result.kind).toBe("block");
  });

  it("block does not suppress transform (security: redaction must apply)", () => {
    const result = aggregatePostDecisions([
      successResult("blocker", { kind: "block", reason: "denied" }),
      successResult("redactor", {
        kind: "transform",
        outputPatch: { secretField: "[REDACTED]" },
      }),
    ]);
    expect(result.kind).toBe("transform");
  });
});

// ---------------------------------------------------------------------------
// Middleware lifecycle dispatch
// ---------------------------------------------------------------------------

describe("createHookMiddleware", () => {
  let executeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    executeSpy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it("has correct phase and priority", () => {
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    expect(mw.name).toBe("hooks");
    expect(mw.phase).toBe("resolve");
    expect(mw.priority).toBe(400);
  });

  describe("onSessionStart", () => {
    it("registers hooks and dispatches session.started event", async () => {
      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeSessionCtx();

      await mw.onSessionStart?.(ctx);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const event = executeSpy.mock.calls[0]?.[1] as HookEvent;
      expect(event.event).toBe("session.started");
      expect(event.agentId).toBe("agent-1");
      expect(event.sessionId).toBe("session-1");
    });

    it("throws when a session.started hook returns block decision", async () => {
      executeSpy.mockResolvedValue([
        successResult("quota-guard", { kind: "block", reason: "quota exceeded" }),
      ]);

      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeSessionCtx();

      await expect(mw.onSessionStart?.(ctx)).rejects.toThrow("Hook blocked session");
    });
  });

  describe("onSessionEnd", () => {
    it("dispatches session.ended event and cleans up", async () => {
      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeSessionCtx();

      // Register first
      await mw.onSessionStart?.(ctx);
      executeSpy.mockClear();

      await mw.onSessionEnd?.(ctx);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const event = executeSpy.mock.calls[0]?.[1] as HookEvent;
      expect(event.event).toBe("session.ended");
    });

    it("does not throw when a session.ended hook returns block (can't block end)", async () => {
      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeSessionCtx();
      await mw.onSessionStart?.(ctx);

      executeSpy.mockResolvedValue([successResult("stubborn", { kind: "block", reason: "no" })]);

      // Should not throw — blocking session end is meaningless
      await expect(mw.onSessionEnd?.(ctx)).resolves.toBeUndefined();
    });

    it("drains pending post-hooks before cleanup so last-turn hooks complete", async () => {
      let turnEndHookCompleted = false;
      executeSpy.mockImplementation(async (_hooks: unknown, event: HookEvent) => {
        if (event.event === "turn.ended") {
          // Simulate a slow post-hook (50ms) — must complete before cleanup
          await new Promise((resolve) => setTimeout(resolve, 50));
          turnEndHookCompleted = true;
        }
        return [];
      });

      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeSessionCtx();
      const turnCtx = makeTurnCtx({ session: ctx });
      await mw.onSessionStart?.(ctx);

      // Trigger a turn end which fires a fire-and-forget turn.ended hook
      await mw.onAfterTurn?.(turnCtx);

      // Post-hook is still in-flight (50ms delay)
      expect(turnEndHookCompleted).toBe(false);

      // onSessionEnd should drain pending post-hooks before cleanup
      await mw.onSessionEnd?.(ctx);

      // After session end, the post-hook must have completed
      expect(turnEndHookCompleted).toBe(true);
    });
  });

  describe("onBeforeTurn", () => {
    it("dispatches turn.started event", async () => {
      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeTurnCtx();

      // Register session first
      await mw.onSessionStart?.(ctx.session);
      executeSpy.mockClear();

      await mw.onBeforeTurn?.(ctx);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const event = executeSpy.mock.calls[0]?.[1] as HookEvent;
      expect(event.event).toBe("turn.started");
    });

    it("throws when a turn.started hook returns block decision", async () => {
      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeTurnCtx();
      await mw.onSessionStart?.(ctx.session);

      executeSpy.mockResolvedValue([
        successResult("rate-limiter", { kind: "block", reason: "rate limited" }),
      ]);

      await expect(mw.onBeforeTurn?.(ctx)).rejects.toThrow("Hook blocked turn");
    });
  });

  describe("onAfterTurn", () => {
    it("dispatches turn.ended event (fire-and-forget)", async () => {
      const mw = createHookMiddleware({ hooks: TEST_HOOKS });
      const ctx = makeTurnCtx();

      await mw.onSessionStart?.(ctx.session);
      executeSpy.mockClear();

      await mw.onAfterTurn?.(ctx);

      // Fire-and-forget: the call is made but not awaited by the middleware
      // Give the microtask queue a tick to resolve
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const event = executeSpy.mock.calls[0]?.[1] as HookEvent;
      expect(event.event).toBe("turn.ended");
    });
  });
});

// ---------------------------------------------------------------------------
// wrapToolCall dispatch + aggregation
// ---------------------------------------------------------------------------

describe("wrapToolCall", () => {
  let executeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    executeSpy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it("calls next() when hooks return continue", async () => {
    executeSpy.mockResolvedValue([successResult("hook-a")]);

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "tool result",
    });

    const request: ToolRequest = { toolId: "bash", input: { cmd: "ls" } };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("tool result");
  });

  it("blocks tool call when hook returns block decision (P10)", async () => {
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, [
      successResult("blocker", { kind: "block", reason: "bash not allowed" }),
    ]);

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "should not reach",
    });

    const request: ToolRequest = { toolId: "bash", input: { cmd: "rm -rf /" } };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    // next() must NOT have been called
    expect(nextFn).not.toHaveBeenCalled();
    // Response indicates the block
    expect(result.output).toEqual({ error: "Hook blocked tool_call: bash not allowed" });
    expect(result.metadata).toEqual({ blockedByHook: true, hookName: "blocker" });
  });

  it("modifies tool input when hook returns modify decision", async () => {
    executeSpy.mockResolvedValue([
      successResult("sanitizer", { kind: "modify", patch: { cmd: "ls -la" } }),
    ]);

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "modified result",
    });

    const request: ToolRequest = { toolId: "bash", input: { cmd: "ls" } };
    await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);

    expect(nextFn).toHaveBeenCalledTimes(1);
    const passedRequest = nextFn.mock.calls[0]?.[0];
    assertDefined(passedRequest);
    expect(passedRequest.input).toEqual({ cmd: "ls -la" });
  });

  it("block wins over modify when hooks disagree (most-restrictive-wins)", async () => {
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, [
      successResult("modifier", { kind: "modify", patch: { safe: true } }),
      successResult("blocker", { kind: "block", reason: "denied" }),
    ]);

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "nope",
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(nextFn).not.toHaveBeenCalled();
    expect(result.output).toEqual({ error: "Hook blocked tool_call: denied" });
  });

  it("pre-call hooks fail-open (failed hooks = no opinion)", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex <= 2) {
        // session start + pre-call: return failure
        return [failureResult("broken-hook", "timeout")];
      }
      // post-call: return success (no transforms)
      return [];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "success despite hook failure",
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("success despite hook failure");
  });

  it("post-call hook failure redacts output (fail-closed)", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex <= 2) return [];
      return [failureResult("broken-hook", "timeout")];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "sensitive data",
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(nextFn).toHaveBeenCalledTimes(1);
    // Raw output suppressed — redacted string, not error object
    expect(result.output).not.toBe("sensitive data");
    expect(typeof result.output).toBe("string");
    expect(result.output).toContain("[output redacted:");
    expect(result.metadata).toMatchObject({ committedButRedacted: true });
  });

  it("post-call event uses effective (modified) input for audit consistency", async () => {
    let postCallEvent: HookEvent | undefined;
    let callIndex = 0;
    executeSpy.mockImplementation(async (_hooks: unknown, event: HookEvent) => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) {
        return [successResult("sanitizer", { kind: "modify", patch: { cmd: "ls -la" } })];
      }
      postCallEvent = event; // post-call
      return [];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "done",
    });

    const request: ToolRequest = { toolId: "bash", input: { cmd: "rm -rf /" } };
    await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);

    // Post-call is now awaited, so event is available immediately
    assertDefined(postCallEvent);
    expect((postCallEvent.data as Record<string, unknown>).input).toEqual({ cmd: "ls -la" });
  });

  it("fires both pre-call and post-call hooks", async () => {
    let callCount = 0;
    executeSpy.mockImplementation(async () => {
      callCount++;
      return [successResult("observer")];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());
    callCount = 0; // reset after session start

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "done",
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);

    // Both pre-call and post-call should have fired (post-call is now awaited)
    expect(callCount).toBe(2);
  });

  it("post-call transform replaces output via shallow merge", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) return [successResult("pre")]; // pre-call: continue
      // post-call: transform
      return [
        successResult("redactor", {
          kind: "transform",
          outputPatch: { redacted: true, extra: "injected" },
        }),
      ];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: { content: "secret data", format: "text" },
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    // next() must still have been called
    expect(nextFn).toHaveBeenCalledTimes(1);
    // Output should be shallow-merged
    expect(result.output).toEqual({
      content: "secret data",
      format: "text",
      redacted: true,
      extra: "injected",
    });
  });

  it("post-call transform injects metadata", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) return [successResult("pre")]; // pre-call
      return [
        successResult("ctx-injector", {
          kind: "transform",
          outputPatch: {},
          metadata: { additionalContext: "see also: docs/api.md" },
        }),
      ];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "result",
      metadata: { existing: true },
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(result.metadata).toEqual({
      existing: true,
      additionalContext: "see also: docs/api.md",
    });
  });

  it("post-call transform replaces non-object output entirely", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) return [successResult("pre")]; // pre-call
      return [
        successResult("replacer", {
          kind: "transform",
          outputPatch: { normalized: true, value: 42 },
        }),
      ];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    // Tool returns a string, not an object
    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "raw string output",
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    // Non-object output gets replaced entirely by outputPatch
    expect(result.output).toEqual({ normalized: true, value: 42 });
  });

  it("post-call continue returns response unchanged", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      return [successResult("observer")]; // pre + post: continue
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "original",
      metadata: { key: "value" },
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(result.output).toBe("original");
    expect(result.metadata).toEqual({ key: "value" });
  });

  it("post-call block is ignored (tool already executed)", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) return [successResult("pre")]; // pre-call
      // post-call: block (should be ignored)
      return [successResult("late-blocker", { kind: "block", reason: "too late" })];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "completed",
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    // next() was called and response returned despite post-call block
    expect(nextFn).toHaveBeenCalledTimes(1);
    // block from aggregateDecisions is not acted upon post-call — only transform is
    // Since block > transform in aggregation, no transform is applied either
    expect(result.output).toBe("completed");
  });

  it("taints response when post-call hooks exceed deadline", async () => {
    let callIndex = 0;
    executeSpy.mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) return [successResult("pre")]; // pre-call
      // post-call: slow hook that exceeds the short deadline
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [
        successResult("slow-redactor", {
          kind: "transform",
          outputPatch: { redacted: true },
        }),
      ];
    });

    // Use a very short deadline to avoid test timeout
    const mw = createHookMiddleware({ hooks: TEST_HOOKS, postToolHookDeadlineMs: 50 });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: { sensitive: "data" },
    });

    const request: ToolRequest = { toolId: "bash", input: {} };
    const result = await mw.wrapToolCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    // Tool completed but deadline expired — output redacted, not error-shaped
    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("[output redacted:");
    expect(result.metadata).toMatchObject({ committedButRedacted: true });
  });
});

// ---------------------------------------------------------------------------
// wrapModelCall dispatch + aggregation
// ---------------------------------------------------------------------------

describe("wrapModelCall", () => {
  let executeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    executeSpy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it("calls next() when hooks return continue", async () => {
    executeSpy.mockResolvedValue([successResult("hook-a")]);

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const modelResponse: ModelResponse = { content: "hello", model: "test-model" };
    const nextFn =
      mock<(req: ModelRequest) => Promise<ModelResponse>>().mockResolvedValue(modelResponse);

    const request: ModelRequest = { messages: [] };
    const result = await mw.wrapModelCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("hello");
  });

  it("modifies only allowed model request fields (allowlist)", async () => {
    executeSpy.mockResolvedValue([
      successResult("rerouter", {
        kind: "modify",
        patch: { model: "cheap-model", temperature: 0.5 },
      }),
    ]);

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ModelRequest) => Promise<ModelResponse>>().mockResolvedValue({
      content: "ok",
      model: "cheap-model",
    });

    const request: ModelRequest = { messages: [], model: "expensive-model", temperature: 1.0 };
    await mw.wrapModelCall?.(makeTurnCtx(), request, nextFn);

    expect(nextFn).toHaveBeenCalledTimes(1);
    const passedRequest = nextFn.mock.calls[0]?.[0];
    assertDefined(passedRequest);
    expect(passedRequest.model).toBe("cheap-model");
    expect(passedRequest.temperature).toBe(0.5);
  });

  it("rejects modify patches targeting immutable fields (messages, tools, systemPrompt, signal)", async () => {
    executeSpy.mockResolvedValue([
      successResult("malicious", {
        kind: "modify",
        patch: { messages: "corrupted", systemPrompt: "injected", signal: null },
      }),
    ]);

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ModelRequest) => Promise<ModelResponse>>().mockResolvedValue({
      content: "safe",
      model: "test",
    });

    const request: ModelRequest = {
      messages: [] as ModelRequest["messages"],
      systemPrompt: "original",
    };
    await mw.wrapModelCall?.(makeTurnCtx(), request, nextFn);

    expect(nextFn).toHaveBeenCalledTimes(1);
    const passedRequest = nextFn.mock.calls[0]?.[0];
    assertDefined(passedRequest);
    // Immutable fields must not be overwritten
    expect(passedRequest.messages).toBe(request.messages);
    expect(passedRequest.systemPrompt).toBe("original");
  });

  it("blocks model call with hook_blocked stop reason and denial message in content", async () => {
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, [
      successResult("guard", { kind: "block", reason: "context too large" }),
    ]);

    const nextFn = mock<(req: ModelRequest) => Promise<ModelResponse>>().mockResolvedValue({
      content: "should not reach",
      model: "test",
    });

    const request: ModelRequest = { messages: [], model: "test-model" };
    const result = await mw.wrapModelCall?.(makeTurnCtx(), request, nextFn);
    assertDefined(result);

    expect(nextFn).not.toHaveBeenCalled();
    expect(result.content).toBe("Hook blocked model_call: context too large");
    expect(result.stopReason).toBe("hook_blocked");
    expect(result.model).toBe("test-model");
    expect(result.metadata).toEqual({
      blockedByHook: true,
      reason: "context too large",
      hookName: "guard",
    });
  });

  it("emits compact.blocked event when hook blocks model call", async () => {
    let blockEvent: HookEvent | undefined;
    let callIndex = 0;
    executeSpy.mockImplementation(async (_hooks: unknown, event: HookEvent) => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) {
        return [successResult("quota-guard", { kind: "block", reason: "over budget" })];
      }
      if (event.event === "compact.blocked") {
        blockEvent = event;
      }
      return [];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    const nextFn = mock<(req: ModelRequest) => Promise<ModelResponse>>().mockResolvedValue({
      content: "nope",
      model: "test",
    });

    await mw.wrapModelCall?.(makeTurnCtx(), { messages: [] }, nextFn);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assertDefined(blockEvent);
    expect(blockEvent.event).toBe("compact.blocked");
    const data = blockEvent.data as Record<string, unknown>;
    expect(data.reason).toBe("over budget");
    expect(data.hookName).toBe("quota-guard");
  });
});

// ---------------------------------------------------------------------------
// wrapModelStream dispatch + aggregation
// ---------------------------------------------------------------------------

describe("wrapModelStream", () => {
  let executeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    executeSpy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it("yields all chunks from next() when hooks return continue", async () => {
    executeSpy.mockResolvedValue([successResult("hook-a")]);

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    async function* fakeStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "hello " };
      yield { kind: "text_delta", delta: "world" };
      yield { kind: "done", response: { content: "hello world", model: "test" } };
    }
    const nextFn: ModelStreamHandler = () => fakeStream();

    const stream = mw.wrapModelStream?.(makeTurnCtx(), { messages: [] }, nextFn);
    assertDefined(stream);
    const chunks = await collectChunks(stream);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.kind).toBe("text_delta");
    expect(chunks[2]?.kind).toBe("done");
  });

  it("yields error chunk with structured fields when hook returns block decision", async () => {
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, [
      successResult("guard", { kind: "block", reason: "not today" }),
    ]);

    const nextFn: ModelStreamHandler = () => {
      throw new Error("should not be called");
    };

    const stream = mw.wrapModelStream?.(makeTurnCtx(), { messages: [] }, nextFn);
    assertDefined(stream);
    const chunks = await collectChunks(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    if (chunks[0]?.kind === "error") {
      expect(chunks[0].message).toContain("not today");
      expect(chunks[0].message).toContain("Hook blocked model_stream");
      expect(chunks[0].code).toBe("PERMISSION");
      expect(chunks[0].retryable).toBe(false);
      expect(chunks[0].retryAfterMs).toBeUndefined();
    }
  });

  it("post-call event uses effective model after hook reroute, not original", async () => {
    let postCallEvent: HookEvent | undefined;
    let callIndex = 0;
    executeSpy.mockImplementation(async (_hooks: unknown, event: HookEvent) => {
      callIndex++;
      if (callIndex === 1) return []; // session start
      if (callIndex === 2) {
        // model.pre — reroute to cheap model
        return [successResult("rerouter", { kind: "modify", patch: { model: "cheap-model" } })];
      }
      // model.post — capture event
      if (event.event === "compact.after") {
        postCallEvent = event;
      }
      return [];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    async function* fakeStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "hi" };
    }
    const nextFn: ModelStreamHandler = () => fakeStream();

    const stream = mw.wrapModelStream?.(
      makeTurnCtx(),
      { messages: [], model: "expensive-model" },
      nextFn,
    );
    assertDefined(stream);
    await collectChunks(stream);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assertDefined(postCallEvent);
    // Should report the effective (rerouted) model, not the original
    expect((postCallEvent.data as Record<string, unknown>).model).toBe("cheap-model");
  });

  it("fires post-call hook after stream completes", async () => {
    let postCallFired = false;
    let callIndex = 0;
    executeSpy.mockImplementation(async (_hooks: unknown, event: HookEvent) => {
      callIndex++;
      if (callIndex >= 3 && event.event === "compact.after") {
        postCallFired = true;
      }
      return [successResult("observer")];
    });

    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await mw.onSessionStart?.(makeSessionCtx());

    async function* fakeStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "hi" };
    }
    const nextFn: ModelStreamHandler = () => fakeStream();

    const stream = mw.wrapModelStream?.(makeTurnCtx(), { messages: [] }, nextFn);
    assertDefined(stream);
    await collectChunks(stream);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postCallFired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  it("returns hook names when hooks are present", () => {
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    const fragment = mw.describeCapabilities(makeTurnCtx());
    expect(fragment).not.toBeUndefined();
    expect(fragment?.label).toBe("hooks");
    expect(fragment?.description).toContain("on-tool-pre");
    expect(fragment?.description).toContain("on-session");
  });

  it("returns undefined when no hooks are configured", () => {
    const mw = createHookMiddleware({ hooks: [] });
    const fragment = mw.describeCapabilities(makeTurnCtx());
    expect(fragment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent hook spawnFn validation (Decision 12A)
// ---------------------------------------------------------------------------

describe("agent hook spawnFn validation", () => {
  it("throws when agent hooks present but spawnFn not provided", () => {
    const agentHooks: readonly HookConfig[] = [{ kind: "agent", name: "verify", prompt: "check" }];
    expect(() => createHookMiddleware({ hooks: agentHooks })).toThrow("spawnFn");
  });

  it("does not throw when agent hooks present and spawnFn provided", () => {
    const agentHooks: readonly HookConfig[] = [{ kind: "agent", name: "verify", prompt: "check" }];
    const spawnFn = mock().mockResolvedValue({ ok: true, output: "" });
    expect(() => createHookMiddleware({ hooks: agentHooks, spawnFn })).not.toThrow();
  });

  it("does not throw when no agent hooks and no spawnFn", () => {
    expect(() => createHookMiddleware({ hooks: TEST_HOOKS })).not.toThrow();
  });

  it("does not throw when spawnFn provided without agent hooks", () => {
    const spawnFn = mock().mockResolvedValue({ ok: true, output: "" });
    expect(() => createHookMiddleware({ hooks: TEST_HOOKS, spawnFn })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onBeforeStop (turn.stop gate)
// ---------------------------------------------------------------------------

describe("onBeforeStop", () => {
  // let justified: mutable spy ref for afterEach cleanup
  let executeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it("returns continue when no hooks match turn.stop", async () => {
    executeSpy = spyOn(executorModule, "executeHooks");
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, []);

    const result = await mw.onBeforeStop?.(makeTurnCtx());
    assertDefined(result);
    expect(result.kind).toBe("continue");
  });

  it("returns block when a hook blocks turn.stop", async () => {
    executeSpy = spyOn(executorModule, "executeHooks");
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, [
      successResult("gate-hook", { kind: "block", reason: "tests not passing" }),
    ]);

    const result = await mw.onBeforeStop?.(makeTurnCtx());
    assertDefined(result);
    expect(result).toEqual({ kind: "block", reason: "tests not passing", blockedBy: "gate-hook" });
  });

  it("dispatches turn.stop event to registry", async () => {
    executeSpy = spyOn(executorModule, "executeHooks");
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, [successResult("gate-hook")]);

    await mw.onBeforeStop?.(makeTurnCtx());

    // Find the call that dispatched turn.stop
    const stopCall = executeSpy.mock.calls.find((call: unknown[]) => {
      const event = call[1] as HookEvent;
      return event.event === "turn.stop";
    });
    expect(stopCall).toBeDefined();
    if (stopCall !== undefined) {
      const event = stopCall[1] as HookEvent;
      expect(event.event).toBe("turn.stop");
      expect(event.agentId).toBe("agent-1");
    }
  });

  it("returns continue when hooks return modify (only block matters)", async () => {
    executeSpy = spyOn(executorModule, "executeHooks");
    const mw = createHookMiddleware({ hooks: TEST_HOOKS });
    await startSessionThen(mw, executeSpy, [
      successResult("mod-hook", { kind: "modify", patch: { x: 1 } }),
    ]);

    const result = await mw.onBeforeStop?.(makeTurnCtx());
    assertDefined(result);
    // modify aggregates to modify, not block — onBeforeStop only cares about block
    expect(result.kind).toBe("continue");
  });
});

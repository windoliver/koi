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
import { aggregateDecisions, createHookMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HOOKS: readonly HookConfig[] = [
  {
    kind: "command",
    name: "on-tool-pre",
    cmd: ["echo", "ok"],
    filter: { events: ["tool.pre"] },
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
    expect(result).toEqual({ kind: "continue" });
  });

  it("returns block when any hook blocks (most restrictive wins)", () => {
    const result = aggregateDecisions([
      successResult("a"),
      successResult("b", { kind: "block", reason: "not allowed" }),
      successResult("c", { kind: "modify", patch: { x: 1 } }),
    ]);
    expect(result).toEqual({ kind: "block", reason: "not allowed" });
  });

  it("merges modify patches when multiple hooks modify", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "modify", patch: { x: 1 } }),
      successResult("b", { kind: "modify", patch: { y: 2 } }),
    ]);
    expect(result).toEqual({ kind: "modify", patch: { x: 1, y: 2 } });
  });

  it("later modify patches override earlier keys", () => {
    const result = aggregateDecisions([
      successResult("a", { kind: "modify", patch: { x: 1 } }),
      successResult("b", { kind: "modify", patch: { x: 99 } }),
    ]);
    expect(result).toEqual({ kind: "modify", patch: { x: 99 } });
  });

  it("ignores failed hooks (fail-open)", () => {
    const result = aggregateDecisions([failureResult("broken", "timeout"), successResult("ok")]);
    expect(result).toEqual({ kind: "continue" });
  });

  it("returns continue for empty results", () => {
    const result = aggregateDecisions([]);
    expect(result).toEqual({ kind: "continue" });
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

      await expect(mw.onSessionStart?.(ctx)).rejects.toThrow("Session blocked by hook");
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

      await expect(mw.onBeforeTurn?.(ctx)).rejects.toThrow("Turn blocked by hook");
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
    expect(result.output).toEqual({ error: "Blocked by hook: bash not allowed" });
    expect(result.metadata).toEqual({ blockedByHook: true });
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
    expect(result.output).toEqual({ error: "Blocked by hook: denied" });
  });

  it("proceeds when hook execution fails (fail-open)", async () => {
    executeSpy.mockResolvedValue([failureResult("broken-hook", "timeout")]);

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

    await new Promise((resolve) => setTimeout(resolve, 10));
    assertDefined(postCallEvent);
    expect((postCallEvent.data as Record<string, unknown>).input).toEqual({ cmd: "ls -la" });
  });

  it("fires post-call hooks after next() returns (fire-and-forget)", async () => {
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

    expect(callCount).toBeGreaterThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Both pre-call and post-call should have fired
    expect(callCount).toBe(2);
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

  it("blocks model call when hook returns block decision", async () => {
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
    expect(result.content).toContain("context too large");
    expect(result.metadata).toEqual({ blockedByHook: true });
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

  it("yields error chunk when hook returns block decision", async () => {
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
    }
  });

  it("fires post-call hook after stream completes", async () => {
    let postCallFired = false;
    let callIndex = 0;
    executeSpy.mockImplementation(async (_hooks: unknown, event: HookEvent) => {
      callIndex++;
      if (callIndex >= 3 && event.event === "model.post") {
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

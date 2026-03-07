import { describe, expect, mock, test } from "bun:test";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createConcurrencyGuard, DEFAULT_CONCURRENCY_GUARD_CONFIG } from "./concurrency-guard.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockTurnContext(overrides?: Partial<TurnContext>): TurnContext {
  const rid = runId("r1");
  return {
    session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function mockModelRequest(): ModelRequest {
  return { messages: [] };
}

function mockModelResponse(): ModelResponse {
  return { content: "ok", model: "test" };
}

function mockToolRequest(toolId = "calc"): ToolRequest {
  return { toolId, input: { a: 1 } };
}

function mockToolResponse(output: unknown = 42): ToolResponse {
  return { output };
}

type ModelNext = (req: ModelRequest) => Promise<ModelResponse>;
type ToolNext = (req: ToolRequest) => Promise<ToolResponse>;
type StreamNext = (req: ModelRequest) => AsyncIterable<ModelChunk>;

function getModelWrap(
  guard: KoiMiddleware,
): (ctx: TurnContext, req: ModelRequest, next: ModelNext) => Promise<ModelResponse> {
  const hook = guard.wrapModelCall;
  if (hook === undefined) throw new Error("wrapModelCall is not defined on guard");
  return hook;
}

function getToolWrap(
  guard: KoiMiddleware,
): (ctx: TurnContext, req: ToolRequest, next: ToolNext) => Promise<ToolResponse> {
  const hook = guard.wrapToolCall;
  if (hook === undefined) throw new Error("wrapToolCall is not defined on guard");
  return hook;
}

function getStreamWrap(
  guard: KoiMiddleware,
): (ctx: TurnContext, req: ModelRequest, next: StreamNext) => AsyncIterable<ModelChunk> {
  const hook = guard.wrapModelStream;
  if (hook === undefined) throw new Error("wrapModelStream is not defined on guard");
  return hook;
}

/** Creates a deferred model response — call resolve() to complete the call. */
function deferredModelNext(): { readonly next: ModelNext; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<ModelResponse>((r) => {
    resolve = () => r(mockModelResponse());
  });
  return { next: () => promise, resolve };
}

/** Creates a deferred tool response — call resolve() to complete the call. */
function deferredToolNext(): { readonly next: ToolNext; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<ToolResponse>((r) => {
    resolve = () => r(mockToolResponse());
  });
  return { next: () => promise, resolve };
}

function mockStreamNext(): StreamNext {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield { kind: "text_delta" as const, delta: "hi" };
      yield { kind: "done" as const, response: mockModelResponse() };
    },
  });
}

async function collectChunks(iter: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const result: ModelChunk[] = [];
  for await (const chunk of iter) {
    result.push(chunk);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Basic behavior
// ---------------------------------------------------------------------------

describe("createConcurrencyGuard", () => {
  test("has name koi:concurrency-guard", () => {
    const guard = createConcurrencyGuard();
    expect(guard.name).toBe("koi:concurrency-guard");
  });

  test("has priority 3", () => {
    const guard = createConcurrencyGuard();
    expect(guard.priority).toBe(3);
  });

  test("describeCapabilities returns live counts", () => {
    const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 3 });
    const ctx = mockTurnContext();
    const cap = guard.describeCapabilities(ctx);
    if (cap === undefined) throw new Error("expected capabilities");
    expect(cap.label).toBe("Concurrency Guard");
    expect(cap.description).toContain("model 0/3");
  });

  test("has all three hooks", () => {
    const guard = createConcurrencyGuard();
    expect(guard.wrapModelCall).toBeDefined();
    expect(guard.wrapModelStream).toBeDefined();
    expect(guard.wrapToolCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  test("default config used when none provided", () => {
    expect(DEFAULT_CONCURRENCY_GUARD_CONFIG.maxConcurrentModelCalls).toBe(5);
    expect(DEFAULT_CONCURRENCY_GUARD_CONFIG.maxConcurrentToolCalls).toBe(10);
    expect(DEFAULT_CONCURRENCY_GUARD_CONFIG.acquireTimeoutMs).toBe(30_000);
  });

  test("partial config merged with defaults", () => {
    const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 2 });
    const ctx = mockTurnContext();
    const cap = guard.describeCapabilities(ctx);
    if (cap === undefined) throw new Error("expected capabilities");
    // model limit is customized
    expect(cap.description).toContain("model 0/2");
    // tool limit is default
    expect(cap.description).toContain("tool 0/10");
  });

  // -------------------------------------------------------------------------
  // Model calls — pass-through under limit
  // -------------------------------------------------------------------------

  test("model call passes through under limit", async () => {
    const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 2 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Tool calls — pass-through under limit
  // -------------------------------------------------------------------------

  test("tool call passes through under limit", async () => {
    const guard = createConcurrencyGuard({ maxConcurrentToolCalls: 2 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest(), next);
    await wrap(ctx, mockToolRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Concurrency — model calls
  // -------------------------------------------------------------------------

  test("blocks model call when all slots taken", async () => {
    const guard = createConcurrencyGuard({
      maxConcurrentModelCalls: 1,
      acquireTimeoutMs: 50,
    });
    const wrap = getModelWrap(guard);
    const ctx = mockTurnContext();
    const d1 = deferredModelNext();

    // Hold the only slot
    const p1 = wrap(ctx, mockModelRequest(), d1.next);

    // Second call should time out
    try {
      await wrap(ctx, mockModelRequest(), d1.next);
      expect.unreachable("should have thrown TIMEOUT");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.retryable).toBe(true);
        expect(e.message).toContain("model slot");
      }
    }

    d1.resolve();
    await p1;
  });

  test("sequential model calls succeed beyond limit (slots released between calls)", async () => {
    const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 1 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    // Three sequential calls with limit 1 — should all succeed
    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Concurrency — tool calls
  // -------------------------------------------------------------------------

  test("blocks tool call when all slots taken", async () => {
    const guard = createConcurrencyGuard({
      maxConcurrentToolCalls: 1,
      acquireTimeoutMs: 50,
    });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();
    const d1 = deferredToolNext();

    // Hold the only slot
    const p1 = wrap(ctx, mockToolRequest(), d1.next);

    // Second call should time out
    try {
      await wrap(ctx, mockToolRequest(), d1.next);
      expect.unreachable("should have thrown TIMEOUT");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.retryable).toBe(true);
        expect(e.message).toContain("tool slot");
      }
    }

    d1.resolve();
    await p1;
  });

  // -------------------------------------------------------------------------
  // Slot release on error
  // -------------------------------------------------------------------------

  test("model slot released on error", async () => {
    const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 1 });
    const wrap = getModelWrap(guard);
    const ctx = mockTurnContext();

    const failingNext: ModelNext = () => Promise.reject(new Error("boom"));
    try {
      await wrap(ctx, mockModelRequest(), failingNext);
    } catch {
      // expected
    }

    // Slot should be available again
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("tool slot released on error", async () => {
    const guard = createConcurrencyGuard({ maxConcurrentToolCalls: 1 });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    const failingNext: ToolNext = () => Promise.reject(new Error("boom"));
    try {
      await wrap(ctx, mockToolRequest(), failingNext);
    } catch {
      // expected
    }

    // Slot should be available again
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    await wrap(ctx, mockToolRequest(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Shared instance limits across sessions
  // -------------------------------------------------------------------------

  test("shared guard limits across two independent sessions", async () => {
    const guard = createConcurrencyGuard({
      maxConcurrentModelCalls: 2,
      acquireTimeoutMs: 50,
    });
    const wrap = getModelWrap(guard);
    const ctxA = mockTurnContext({ turnIndex: 0 });
    const ctxB = mockTurnContext({ turnIndex: 1 });
    const d1 = deferredModelNext();
    const d2 = deferredModelNext();

    // Session A takes slot 1
    const p1 = wrap(ctxA, mockModelRequest(), d1.next);
    // Session B takes slot 2
    const p2 = wrap(ctxB, mockModelRequest(), d2.next);

    // Session A again — should time out (all 2 slots held)
    try {
      await wrap(ctxA, mockModelRequest(), d1.next);
      expect.unreachable("should have thrown TIMEOUT");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
    }

    d1.resolve();
    d2.resolve();
    await p1;
    await p2;
  });

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  test("stream slot acquired on iteration start, released on completion", async () => {
    const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 1 });
    const streamWrap = getStreamWrap(guard);
    const ctx = mockTurnContext();

    const chunks = await collectChunks(streamWrap(ctx, mockModelRequest(), mockStreamNext()));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.kind).toBe("text_delta");
    expect(chunks[1]?.kind).toBe("done");

    // Slot released — second stream should succeed
    const chunks2 = await collectChunks(streamWrap(ctx, mockModelRequest(), mockStreamNext()));
    expect(chunks2).toHaveLength(2);
  });

  test("stream slot released on iteration error", async () => {
    const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 1 });
    const streamWrap = getStreamWrap(guard);
    const ctx = mockTurnContext();

    const failingStreamNext: StreamNext = () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "text_delta" as const, delta: "hi" };
        throw new Error("stream boom");
      },
    });

    try {
      await collectChunks(streamWrap(ctx, mockModelRequest(), failingStreamNext));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toBe("stream boom");
      }
    }

    // Slot released — next stream should succeed
    const chunks = await collectChunks(streamWrap(ctx, mockModelRequest(), mockStreamNext()));
    expect(chunks).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  test("throws KoiRuntimeError with TIMEOUT code and retryable: true", async () => {
    const guard = createConcurrencyGuard({
      maxConcurrentModelCalls: 1,
      acquireTimeoutMs: 20,
    });
    const wrap = getModelWrap(guard);
    const ctx = mockTurnContext();
    const d1 = deferredModelNext();

    // Hold the slot
    const p1 = wrap(ctx, mockModelRequest(), d1.next);

    try {
      await wrap(ctx, mockModelRequest(), d1.next);
      expect.unreachable("should have thrown TIMEOUT");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.retryable).toBe(true);
        if (e.context === undefined) throw new Error("expected context");
        expect(e.context.kind).toBe("model");
        expect(e.context.maxConcurrency).toBe(1);
        expect(e.context.acquireTimeoutMs).toBe(20);
      }
    }

    d1.resolve();
    await p1;
  });

  test("custom acquireTimeoutMs respected", async () => {
    const guard = createConcurrencyGuard({
      maxConcurrentToolCalls: 1,
      acquireTimeoutMs: 15,
    });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();
    const d1 = deferredToolNext();

    const p1 = wrap(ctx, mockToolRequest(), d1.next);

    const start = Date.now();
    try {
      await wrap(ctx, mockToolRequest(), d1.next);
      expect.unreachable("should have timed out");
    } catch (e: unknown) {
      const elapsed = Date.now() - start;
      expect(e).toBeInstanceOf(KoiRuntimeError);
      // Should time out within reasonable tolerance of 15ms (allow up to 200ms for CI)
      expect(elapsed).toBeLessThan(200);
    }

    d1.resolve();
    await p1;
  });
});

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
import { KoiEngineError } from "./errors.js";
import { createIterationGuard, createLoopDetector, createSpawnGuard, fnv1a } from "./guards.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockTurnContext(overrides?: Partial<TurnContext>): TurnContext {
  return {
    session: { agentId: "a1", sessionId: "s1", metadata: {} },
    turnIndex: 0,
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function mockModelRequest(): ModelRequest {
  return { messages: [] };
}

function mockModelResponse(usage?: { inputTokens: number; outputTokens: number }): ModelResponse {
  return { content: "ok", model: "test", ...(usage ? { usage } : {}) };
}

function mockToolRequest(toolId = "calc", input: Record<string, unknown> = { a: 1 }): ToolRequest {
  return { toolId, input };
}

function mockToolResponse(output: unknown = 42): ToolResponse {
  return { output };
}

type ModelNext = (req: ModelRequest) => Promise<ModelResponse>;
type ToolNext = (req: ToolRequest) => Promise<ToolResponse>;

/** Extract wrapModelCall from a guard, asserting it exists. */
function getModelWrap(
  guard: KoiMiddleware,
): (ctx: TurnContext, req: ModelRequest, next: ModelNext) => Promise<ModelResponse> {
  const hook = guard.wrapModelCall;
  expect(hook).toBeDefined();
  // Safe: we just asserted it's defined
  return hook as (ctx: TurnContext, req: ModelRequest, next: ModelNext) => Promise<ModelResponse>;
}

/** Extract wrapToolCall from a guard, asserting it exists. */
function getToolWrap(
  guard: KoiMiddleware,
): (ctx: TurnContext, req: ToolRequest, next: ToolNext) => Promise<ToolResponse> {
  const hook = guard.wrapToolCall;
  expect(hook).toBeDefined();
  return hook as (ctx: TurnContext, req: ToolRequest, next: ToolNext) => Promise<ToolResponse>;
}

// ---------------------------------------------------------------------------
// FNV-1a
// ---------------------------------------------------------------------------

describe("fnv1a", () => {
  test("returns a number", () => {
    expect(typeof fnv1a("hello")).toBe("number");
  });

  test("same input produces same hash", () => {
    expect(fnv1a("test")).toBe(fnv1a("test"));
  });

  test("different input produces different hash", () => {
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });

  test("empty string produces known offset basis", () => {
    // FNV-1a 32-bit of empty string = offset basis itself since no bytes are processed
    expect(fnv1a("")).toBe(0x811c9dc5);
  });

  test("produces unsigned 32-bit integer", () => {
    const hash = fnv1a("test string");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// IterationGuard
// ---------------------------------------------------------------------------

describe("createIterationGuard", () => {
  test("has name koi:iteration-guard", () => {
    const guard = createIterationGuard();
    expect(guard.name).toBe("koi:iteration-guard");
  });

  test("passes through when under turn limit", async () => {
    const guard = createIterationGuard({ maxTurns: 5 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("passes through for multiple calls under limit", async () => {
    const guard = createIterationGuard({ maxTurns: 3 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("throws KoiEngineError when turn limit reached", async () => {
    const guard = createIterationGuard({ maxTurns: 2 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    // Use up 2 turns
    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);

    // 3rd call should throw
    try {
      await wrap(ctx, mockModelRequest(), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Max turns exceeded");
      }
    }
  });

  test("throws at exactly maxTurns (boundary)", async () => {
    const guard = createIterationGuard({ maxTurns: 1 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    // First call succeeds
    await wrap(ctx, mockModelRequest(), next);

    // Second call fails (turns = 1 = maxTurns)
    await expect(wrap(ctx, mockModelRequest(), next)).rejects.toBeInstanceOf(KoiEngineError);
  });

  test("tracks token usage across calls", async () => {
    const guard = createIterationGuard({ maxTokens: 100 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() =>
      Promise.resolve(mockModelResponse({ inputTokens: 30, outputTokens: 20 })),
    );
    const ctx = mockTurnContext();

    await wrap(ctx, mockModelRequest(), next); // 50 tokens
    await wrap(ctx, mockModelRequest(), next); // 100 tokens total

    // Next call should throw
    try {
      await wrap(ctx, mockModelRequest(), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Token budget exhausted");
      }
    }
  });

  test("handles missing usage in response", async () => {
    const guard = createIterationGuard({ maxTokens: 100 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    // No usage → tokens stay at 0, should not throw
    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("uses defaults when no config provided", () => {
    const guard = createIterationGuard();
    expect(guard.name).toBe("koi:iteration-guard");
    // Should not throw on first call with defaults (maxTurns: 25)
  });
});

// ---------------------------------------------------------------------------
// LoopDetector
// ---------------------------------------------------------------------------

describe("createLoopDetector", () => {
  test("has name koi:loop-detector", () => {
    const detector = createLoopDetector();
    expect(detector.name).toBe("koi:loop-detector");
  });

  test("passes through for unique tool calls", async () => {
    const detector = createLoopDetector({ windowSize: 4, threshold: 3 });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("tool1"), next);
    await wrap(ctx, mockToolRequest("tool2"), next);
    await wrap(ctx, mockToolRequest("tool3"), next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  test("passes through for repeated calls below threshold", async () => {
    const detector = createLoopDetector({ windowSize: 8, threshold: 3 });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Same call twice — under threshold of 3
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("throws when repeated calls reach threshold", async () => {
    const detector = createLoopDetector({ windowSize: 8, threshold: 3 });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);

    // 3rd identical call should trigger loop detection
    try {
      await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("Loop detected");
        expect(e.message).toContain("calc");
      }
    }
  });

  test("different arguments don't trigger loop detection", async () => {
    const detector = createLoopDetector({ windowSize: 8, threshold: 3 });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 3 }), next);
    expect(next).toHaveBeenCalledTimes(3); // All unique
  });

  test("window slides — old hashes fall off", async () => {
    const detector = createLoopDetector({ windowSize: 3, threshold: 3 });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // First two identical calls
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);

    // Break the pattern with different calls to push old hashes out
    await wrap(ctx, mockToolRequest("other", { b: 2 }), next);
    await wrap(ctx, mockToolRequest("another", { c: 3 }), next);

    // Now only 1 "calc:a=1" in window of 3, so this should pass
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(next).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// SpawnGuard
// ---------------------------------------------------------------------------

describe("createSpawnGuard", () => {
  test("has name koi:spawn-guard", () => {
    const guard = createSpawnGuard();
    expect(guard.name).toBe("koi:spawn-guard");
  });

  test("passes through non-forge tool calls", async () => {
    const guard = createSpawnGuard({ maxTotalProcesses: 2 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc"), next);
    await wrap(ctx, mockToolRequest("search"), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("allows forge_agent calls under limit", async () => {
    const guard = createSpawnGuard({ maxTotalProcesses: 3 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // activeProcesses starts at 1 (current agent)
    await wrap(ctx, mockToolRequest("forge_agent"), next); // 2 total
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("throws when total process limit reached", async () => {
    const guard = createSpawnGuard({ maxTotalProcesses: 2 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // activeProcesses = 1, spawn one more = 2 = maxTotalProcesses
    await wrap(ctx, mockToolRequest("forge_agent"), next);

    // Now at limit — next spawn should fail
    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("PERMISSION");
        expect(e.message).toContain("Max total processes exceeded");
      }
    }
  });

  test("non-forge calls don't count toward process limit", async () => {
    const guard = createSpawnGuard({ maxTotalProcesses: 2 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // These don't affect process count
    await wrap(ctx, mockToolRequest("calc"), next);
    await wrap(ctx, mockToolRequest("search"), next);
    await wrap(ctx, mockToolRequest("calc"), next);

    // This one does — should succeed (active=1 < max=2)
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("throws when child would exceed maxDepth", async () => {
    // Agent at depth 2, maxDepth 2 → child would be at depth 3 → denied
    const guard = createSpawnGuard({ maxDepth: 2 }, 2);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("PERMISSION");
        expect(e.message).toContain("Max spawn depth exceeded");
        expect(e.message).toContain("depth 3");
      }
    }
    expect(next).not.toHaveBeenCalled();
  });

  test("allows spawn when within maxDepth", async () => {
    // Agent at depth 0, maxDepth 3 → child at depth 1 → allowed
    const guard = createSpawnGuard({ maxDepth: 3 }, 0);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("throws when fan-out limit reached", async () => {
    const guard = createSpawnGuard({ maxFanOut: 2 }, 0);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Spawn 2 children successfully
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    await wrap(ctx, mockToolRequest("forge_agent"), next);

    // 3rd spawn should fail (directChildren=2, maxFanOut=2)
    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("PERMISSION");
        expect(e.message).toContain("Max fan-out exceeded");
        expect(e.message).toContain("2/2");
      }
    }
  });

  test("allows spawn when under fan-out limit", async () => {
    const guard = createSpawnGuard({ maxFanOut: 3 }, 0);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("depth and fan-out checked independently of total processes", async () => {
    // High total process limit, but tight depth and fan-out
    const guard = createSpawnGuard({ maxTotalProcesses: 100, maxDepth: 1, maxFanOut: 1 }, 0);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // First spawn succeeds (depth 0→1 OK, fanOut 0<1 OK, total 1<100 OK)
    await wrap(ctx, mockToolRequest("forge_agent"), next);

    // Second spawn fails on fan-out (directChildren=1, maxFanOut=1)
    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("PERMISSION");
        expect(e.message).toContain("Max fan-out exceeded");
      }
    }
  });

  test("all three limits enforced together", async () => {
    // Depth OK (0→1 ≤ 3), fan-out OK (0 < 5), but total processes at limit
    const guard = createSpawnGuard({ maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 1 }, 0);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Total processes = 1 = maxTotalProcesses → denied
    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("PERMISSION");
        expect(e.message).toContain("Max total processes exceeded");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// IterationGuard — streaming
// ---------------------------------------------------------------------------

type StreamNext = (req: ModelRequest) => AsyncIterable<ModelChunk>;

/** Extract wrapModelStream from a guard, asserting it exists. */
function getStreamWrap(
  guard: KoiMiddleware,
): (ctx: TurnContext, req: ModelRequest, next: StreamNext) => AsyncIterable<ModelChunk> {
  const hook = guard.wrapModelStream;
  expect(hook).toBeDefined();
  return hook as (
    ctx: TurnContext,
    req: ModelRequest,
    next: StreamNext,
  ) => AsyncIterable<ModelChunk>;
}

function mockStreamNext(usage?: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): StreamNext {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield { kind: "text_delta" as const, delta: "hi" };
      yield {
        kind: "done" as const,
        response: mockModelResponse(usage),
      };
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

describe("createIterationGuard streaming", () => {
  test("has wrapModelStream hook", () => {
    const guard = createIterationGuard();
    expect(guard.wrapModelStream).toBeDefined();
  });

  test("passes through stream under limits", async () => {
    const guard = createIterationGuard({ maxTurns: 5 });
    const wrap = getStreamWrap(guard);
    const next = mockStreamNext();
    const ctx = mockTurnContext();

    const chunks = await collectChunks(wrap(ctx, mockModelRequest(), next));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.kind).toBe("text_delta");
    expect(chunks[1]?.kind).toBe("done");
  });

  test("tracks turns from done chunks", async () => {
    const guard = createIterationGuard({ maxTurns: 2 });
    const wrap = getStreamWrap(guard);
    const next = mockStreamNext();
    const ctx = mockTurnContext();

    // Stream 1 — uses 1 turn
    await collectChunks(wrap(ctx, mockModelRequest(), next));
    // Stream 2 — uses 1 turn (now at 2)
    await collectChunks(wrap(ctx, mockModelRequest(), next));

    // Stream 3 — should throw (turns=2, maxTurns=2)
    try {
      await collectChunks(wrap(ctx, mockModelRequest(), next));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Max turns exceeded");
      }
    }
  });

  test("tracks tokens from done chunks across calls", async () => {
    const guard = createIterationGuard({ maxTokens: 100 });
    const wrap = getStreamWrap(guard);
    const next = mockStreamNext({ inputTokens: 30, outputTokens: 20 });
    const ctx = mockTurnContext();

    await collectChunks(wrap(ctx, mockModelRequest(), next)); // 50 tokens
    await collectChunks(wrap(ctx, mockModelRequest(), next)); // 100 tokens total

    // Next call should throw
    try {
      await collectChunks(wrap(ctx, mockModelRequest(), next));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Token budget exhausted");
      }
    }
  });

  test("mixed streaming/non-streaming calls share counters", async () => {
    const guard = createIterationGuard({ maxTurns: 3 });
    const modelWrap = getModelWrap(guard);
    const streamWrap = getStreamWrap(guard);
    const ctx = mockTurnContext();

    // 1 non-streaming call
    const modelNext: ModelNext = mock(() =>
      Promise.resolve(mockModelResponse({ inputTokens: 10, outputTokens: 5 })),
    );
    await modelWrap(ctx, mockModelRequest(), modelNext);

    // 1 streaming call
    const streamNext = mockStreamNext({ inputTokens: 10, outputTokens: 5 });
    await collectChunks(streamWrap(ctx, mockModelRequest(), streamNext));

    // 1 more streaming call
    await collectChunks(streamWrap(ctx, mockModelRequest(), streamNext));

    // 4th call should throw (turns=3, maxTurns=3)
    try {
      await collectChunks(streamWrap(ctx, mockModelRequest(), streamNext));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
    }
  });

  test("thinking_delta chunks pass through without affecting counters", async () => {
    const guard = createIterationGuard({ maxTurns: 2 });
    const streamWrap = getStreamWrap(guard);
    const ctx = mockTurnContext();

    // Stream with thinking_delta chunks interspersed
    const thinkingChunks: readonly ModelChunk[] = [
      { kind: "thinking_delta", delta: "reasoning..." },
      { kind: "thinking_delta", delta: "more thinking" },
      { kind: "text_delta", delta: "hi" },
      { kind: "done", response: mockModelResponse({ inputTokens: 10, outputTokens: 5 }) },
    ];
    const thinkingNext: StreamNext = () => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of thinkingChunks) {
          yield chunk;
        }
      },
    });

    const chunks = await collectChunks(streamWrap(ctx, mockModelRequest(), thinkingNext));
    // All 4 chunks should pass through
    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.kind).toBe("thinking_delta");
    expect(chunks[1]?.kind).toBe("thinking_delta");
    expect(chunks[2]?.kind).toBe("text_delta");
    expect(chunks[3]?.kind).toBe("done");

    // Should have counted 1 turn (from the done chunk), second stream should still work
    await collectChunks(streamWrap(ctx, mockModelRequest(), thinkingNext));

    // Third call should throw (turns=2, maxTurns=2)
    try {
      await collectChunks(streamWrap(ctx, mockModelRequest(), thinkingNext));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
    }
  });

  test("thinking_delta chunks pass through streaming chain composition", async () => {
    const guard = createIterationGuard({ maxTurns: 5 });
    const streamWrap = getStreamWrap(guard);
    const ctx = mockTurnContext();

    const streamData: readonly ModelChunk[] = [
      { kind: "thinking_delta", delta: "step 1" },
      { kind: "text_delta", delta: "output" },
      { kind: "done", response: mockModelResponse() },
    ];
    const thinkingStream: StreamNext = () => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of streamData) {
          yield chunk;
        }
      },
    });

    const chunks = await collectChunks(streamWrap(ctx, mockModelRequest(), thinkingStream));
    const filtered = chunks.filter((c) => c.kind === "thinking_delta");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe("thinking_delta");
    if (filtered[0]?.kind === "thinking_delta") {
      expect(filtered[0].delta).toBe("step 1");
    }
  });

  test("interrupted stream (no done chunk) does not count turn", async () => {
    const guard = createIterationGuard({ maxTurns: 2 });
    const streamWrap = getStreamWrap(guard);
    const ctx = mockTurnContext();

    // Interrupted stream — yields text but no done chunk
    const interruptedNext: StreamNext = () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "text_delta" as const, delta: "partial" };
        // no done chunk — stream interrupted
      },
    });

    await collectChunks(streamWrap(ctx, mockModelRequest(), interruptedNext));

    // Should NOT have counted a turn, so two more complete streams should succeed
    const normalNext = mockStreamNext();
    await collectChunks(streamWrap(ctx, mockModelRequest(), normalNext));
    await collectChunks(streamWrap(ctx, mockModelRequest(), normalNext));

    // Now turns=2, next should throw
    try {
      await collectChunks(streamWrap(ctx, mockModelRequest(), normalNext));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
    }
  });
});

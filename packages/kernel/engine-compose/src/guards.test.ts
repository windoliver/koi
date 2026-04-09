import { describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  GovernanceCheck,
  GovernanceController,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SessionContext,
  SubsystemToken,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { GOVERNANCE, runId, sessionId, turnId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { fnv1a } from "@koi/hash";
import {
  createIterationGuard,
  createLoopDetector,
  createSpawnGuard,
  detectRepeatingPattern,
} from "./guards.js";

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

function mockSessionContext(): SessionContext {
  return { agentId: "a1", sessionId: sessionId("s1"), runId: runId("r1"), metadata: {} };
}

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

  test("throws KoiRuntimeError when turn limit reached", async () => {
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
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
    await expect(wrap(ctx, mockModelRequest(), next)).rejects.toBeInstanceOf(KoiRuntimeError);
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
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

  test("throws KoiRuntimeError when duration limit exceeded", async () => {
    // Very short duration limit
    const guard = createIterationGuard({ maxDurationMs: 1 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(async () => {
      // Delay to ensure duration exceeds 1ms
      await new Promise((r) => setTimeout(r, 10));
      return mockModelResponse();
    });
    const ctx = mockTurnContext();

    // First call succeeds (checkLimits runs before next(), elapsed ~ 0ms)
    await wrap(ctx, mockModelRequest(), next);

    // Second call: elapsed > 1ms, should throw
    try {
      await wrap(ctx, mockModelRequest(), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Duration limit exceeded");
      }
    }
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
    const detector = createLoopDetector({ windowSize: 4, threshold: 3, noProgressEnabled: false });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("tool1"), next);
    await wrap(ctx, mockToolRequest("tool2"), next);
    await wrap(ctx, mockToolRequest("tool3"), next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  test("passes through for repeated calls below threshold", async () => {
    const detector = createLoopDetector({ windowSize: 8, threshold: 3, noProgressEnabled: false });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Same call twice — under threshold of 3
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("throws when repeated calls reach threshold", async () => {
    const detector = createLoopDetector({ windowSize: 8, threshold: 3, noProgressEnabled: false });
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Loop detected");
        expect(e.message).toContain("calc");
      }
    }
  });

  test("different arguments don't trigger loop detection", async () => {
    const detector = createLoopDetector({ windowSize: 8, threshold: 3, noProgressEnabled: false });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 3 }), next);
    expect(next).toHaveBeenCalledTimes(3); // All unique
  });

  test("fires onWarning when warningThreshold is reached", async () => {
    const warnings: unknown[] = [];
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
      noProgressEnabled: false,
      onWarning: (info) => warnings.push(info),
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(warnings).toHaveLength(0);

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      toolId: "calc",
      repeatCount: 2,
      windowSize: 8,
      warningThreshold: 2,
      threshold: 4,
    });
  });

  test("warning fires at most once per unique hash", async () => {
    const warnings: unknown[] = [];
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
      noProgressEnabled: false,
      onWarning: (info) => warnings.push(info),
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next); // fires warning
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next); // does NOT fire again
    expect(warnings).toHaveLength(1);
  });

  test("different tools fire independent warnings", async () => {
    const warnings: unknown[] = [];
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
      noProgressEnabled: false,
      onWarning: (info) => warnings.push(info),
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next); // warning for calc
    await wrap(ctx, mockToolRequest("search", { q: "x" }), next);
    await wrap(ctx, mockToolRequest("search", { q: "x" }), next); // warning for search
    expect(warnings).toHaveLength(2);
    expect((warnings[0] as { toolId: string }).toolId).toBe("calc");
    expect((warnings[1] as { toolId: string }).toolId).toBe("search");
  });

  test("warning fires on earlier call than throw", async () => {
    const warnings: unknown[] = [];
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      warningThreshold: 2,
      noProgressEnabled: false,
      onWarning: (info) => warnings.push(info),
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next); // count=1
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next); // count=2, warning fires

    expect(warnings).toHaveLength(1);

    // count=3, loop throws
    try {
      await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
    }
  });

  test("no warning when warningThreshold is not configured", async () => {
    const onWarning = mock(() => {});
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      noProgressEnabled: false,
      // warningThreshold not set
      onWarning,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(onWarning).not.toHaveBeenCalled();
  });

  test("throws VALIDATION at construction if warningThreshold >= threshold", () => {
    try {
      createLoopDetector({ warningThreshold: 3, threshold: 3 });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("warningThreshold");
      }
    }
  });

  test("warningThreshold equal to threshold throws VALIDATION", () => {
    try {
      createLoopDetector({ warningThreshold: 5, threshold: 5 });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
      }
    }
  });

  test("onWarning without warningThreshold does not fire", async () => {
    const onWarning = mock(() => {});
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      noProgressEnabled: false,
      onWarning,
      // warningThreshold not set
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(onWarning).not.toHaveBeenCalled();
  });

  test("skips input hashing for large inputs (maxInputKeys)", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      maxInputKeys: 2,
      noProgressEnabled: false,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Large input (3 keys > maxInputKeys=2): fingerprint falls back to toolId only
    const largeInput = { a: 1, b: 2, c: 3 };
    await wrap(ctx, mockToolRequest("calc", largeInput), next);
    await wrap(ctx, mockToolRequest("calc", { x: 9, y: 8, z: 7 }), next);

    // Both have same toolId-only fingerprint, so count=2
    // Third call with different large input should still trigger threshold
    try {
      await wrap(ctx, mockToolRequest("calc", { p: 1, q: 2, r: 3 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Loop detected");
      }
    }
  });

  test("small inputs still use full fingerprint with maxInputKeys", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      maxInputKeys: 5,
      noProgressEnabled: false,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Small input (1 key < maxInputKeys=5): full fingerprint used
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 3 }), next);
    // All have different inputs, so no loop detected
    expect(next).toHaveBeenCalledTimes(3);
  });

  test("window slides — old hashes fall off", async () => {
    const detector = createLoopDetector({ windowSize: 3, threshold: 3, noProgressEnabled: false });
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
// LoopDetector — warning injection
// ---------------------------------------------------------------------------

describe("createLoopDetector warning injection", () => {
  test("injects warning into ModelRequest on next model call", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
    });
    const toolWrap = getToolWrap(detector);
    const modelWrap = getModelWrap(detector);
    const toolNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Trigger warning via 2 identical tool calls
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);

    // Next model call should have injected warning
    const capturedRequest: ModelRequest[] = [];
    const capturingNext: ModelNext = mock((req: ModelRequest) => {
      capturedRequest.push(req);
      return Promise.resolve(mockModelResponse());
    });
    await modelWrap(ctx, mockModelRequest(), capturingNext);

    expect(capturedRequest).toHaveLength(1);
    const injectedMessages = capturedRequest[0]?.messages ?? [];
    expect(injectedMessages.length).toBeGreaterThan(0);
    const systemMsg = injectedMessages[0] as InboundMessage;
    expect(systemMsg.senderId).toBe("system:loop-detector");
    expect(systemMsg.content[0]).toBeDefined();
    if (systemMsg.content[0]?.kind === "text") {
      expect(systemMsg.content[0].text).toContain("calc");
      expect(systemMsg.content[0].text).toContain("2 times");
      expect(systemMsg.content[0].text).toContain("MUST try a different approach");
    }
  });

  test("clears pending warnings after injection", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
    });
    const toolWrap = getToolWrap(detector);
    const modelWrap = getModelWrap(detector);
    const toolNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Trigger warning
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);

    // First model call injects warning
    const capturedFirst: ModelRequest[] = [];
    await modelWrap(
      ctx,
      mockModelRequest(),
      mock((req: ModelRequest) => {
        capturedFirst.push(req);
        return Promise.resolve(mockModelResponse());
      }),
    );
    expect((capturedFirst[0]?.messages ?? []).length).toBeGreaterThan(0);

    // Second model call should NOT inject (cleared)
    const capturedSecond: ModelRequest[] = [];
    await modelWrap(
      ctx,
      mockModelRequest(),
      mock((req: ModelRequest) => {
        capturedSecond.push(req);
        return Promise.resolve(mockModelResponse());
      }),
    );
    expect(capturedSecond[0]?.messages ?? []).toHaveLength(0);
  });

  test("injects warning into streaming ModelRequest", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
    });
    const toolWrap = getToolWrap(detector);
    const streamWrap = getStreamWrap(detector);
    const toolNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Trigger warning
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);

    // Stream call should have injected warning
    const capturedRequest: ModelRequest[] = [];
    const capturingStreamNext: StreamNext = (req: ModelRequest) => {
      capturedRequest.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { kind: "text_delta" as const, delta: "hi" };
          yield { kind: "done" as const, response: mockModelResponse() };
        },
      };
    };
    await collectChunks(streamWrap(ctx, mockModelRequest(), capturingStreamNext));

    expect(capturedRequest).toHaveLength(1);
    const injectedMessages = capturedRequest[0]?.messages ?? [];
    expect(injectedMessages.length).toBeGreaterThan(0);
    const systemMsg = injectedMessages[0] as InboundMessage;
    expect(systemMsg.senderId).toBe("system:loop-detector");
  });

  test("does not inject when injectWarning is false", () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
      injectWarning: false,
    });

    // Hooks should not be attached at all — no overhead on the hot path
    expect(detector.wrapModelCall).toBeUndefined();
    expect(detector.wrapModelStream).toBeUndefined();
  });

  test("onWarning callback still fires alongside injection", async () => {
    const warnings: unknown[] = [];
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
      onWarning: (info) => warnings.push(info),
    });
    const toolWrap = getToolWrap(detector);
    const modelWrap = getModelWrap(detector);
    const toolNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Trigger warning
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);

    // Callback fired
    expect(warnings).toHaveLength(1);

    // Injection also happened
    const capturedRequest: ModelRequest[] = [];
    await modelWrap(
      ctx,
      mockModelRequest(),
      mock((req: ModelRequest) => {
        capturedRequest.push(req);
        return Promise.resolve(mockModelResponse());
      }),
    );
    const injectedMessages = capturedRequest[0]?.messages ?? [];
    expect(injectedMessages.length).toBeGreaterThan(0);
    expect((injectedMessages[0] as InboundMessage).senderId).toBe("system:loop-detector");
  });

  test("batches warnings from multiple tools into single injection", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
    });
    const toolWrap = getToolWrap(detector);
    const modelWrap = getModelWrap(detector);
    const toolNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Trigger warnings for two different tools
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext);
    await toolWrap(ctx, mockToolRequest("calc", { a: 1 }), toolNext); // warning for calc
    await toolWrap(ctx, mockToolRequest("search", { q: "x" }), toolNext);
    await toolWrap(ctx, mockToolRequest("search", { q: "x" }), toolNext); // warning for search

    // Next model call should contain both warnings in one message
    const capturedRequest: ModelRequest[] = [];
    await modelWrap(
      ctx,
      mockModelRequest(),
      mock((req: ModelRequest) => {
        capturedRequest.push(req);
        return Promise.resolve(mockModelResponse());
      }),
    );

    const injectedMessages = capturedRequest[0]?.messages ?? [];
    expect(injectedMessages).toHaveLength(1);
    const systemMsg = injectedMessages[0] as InboundMessage;
    expect(systemMsg.senderId).toBe("system:loop-detector");
    if (systemMsg.content[0]?.kind === "text") {
      expect(systemMsg.content[0].text).toContain("calc");
      expect(systemMsg.content[0].text).toContain("search");
    }
  });

  test("no injection when warningThreshold is not set", () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      // warningThreshold not set → no injection possible
    });

    // Hooks should not be attached at all — no overhead on the hot path
    expect(detector.wrapModelCall).toBeUndefined();
    expect(detector.wrapModelStream).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SpawnGuard
// ---------------------------------------------------------------------------

/** Creates a deferred tool response — call resolve() to complete the spawn. */
function deferredToolNext(): { readonly next: ToolNext; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<ToolResponse>((r) => {
    resolve = () => r(mockToolResponse());
  });
  return { next: () => promise, resolve };
}

/** Minimal mock Agent for GovernanceController testing. */
function mockAgent(governance?: GovernanceController): Agent {
  const components = new Map<string, unknown>();
  if (governance) {
    components.set(GOVERNANCE as string, governance);
  }
  return {
    pid: { id: "a1" as Agent["pid"]["id"], name: "test", type: "copilot", depth: 0 },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "running",
    component: <T>(tok: { toString(): string }) => components.get(tok as string) as T | undefined,
    has: (tok) => components.has(tok as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: () => components as ReadonlyMap<string, unknown>,
  };
}

describe("createSpawnGuard", () => {
  // -------------------------------------------------------------------------
  // Basic behavior
  // -------------------------------------------------------------------------

  test("has name koi:spawn-guard", () => {
    const guard = createSpawnGuard();
    expect(guard.name).toBe("koi:spawn-guard");
  });

  test("passes through non-forge tool calls", async () => {
    const guard = createSpawnGuard({ policy: { maxTotalProcesses: 2 } });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc"), next);
    await wrap(ctx, mockToolRequest("search"), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("allows forge_agent calls under limit", async () => {
    const guard = createSpawnGuard({ agentDepth: 0 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("non-forge calls don't count toward fan-out", async () => {
    const guard = createSpawnGuard({ agentDepth: 0, policy: { maxFanOut: 2 } });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("calc"), next);
    await wrap(ctx, mockToolRequest("search"), next);
    await wrap(ctx, mockToolRequest("calc"), next);

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // Depth checks (PERMISSION error — structural, not retryable)
  // -------------------------------------------------------------------------

  test("throws PERMISSION when child would exceed maxDepth", async () => {
    const guard = createSpawnGuard({ policy: { maxDepth: 2 }, agentDepth: 2 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("PERMISSION");
        expect(e.message).toContain("Max spawn depth exceeded");
        expect(e.message).toContain("depth 3");
      }
    }
    expect(next).not.toHaveBeenCalled();
  });

  test("allows spawn when within maxDepth", async () => {
    const guard = createSpawnGuard({ policy: { maxDepth: 3 }, agentDepth: 0 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("allows spawn at exactly maxDepth (boundary)", async () => {
    // Agent at depth 2, maxDepth 3 → child at depth 3 = maxDepth → allowed
    const guard = createSpawnGuard({ policy: { maxDepth: 3 }, agentDepth: 2 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Fan-out checks (RATE_LIMIT error — retryable when child completes)
  // -------------------------------------------------------------------------

  test("throws RATE_LIMIT when concurrent spawns exceed fan-out", async () => {
    const guard = createSpawnGuard({ policy: { maxFanOut: 2 }, agentDepth: 0 });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    // Start 2 concurrent spawns (don't resolve yet)
    const d1 = deferredToolNext();
    const d2 = deferredToolNext();
    const p1 = wrap(ctx, mockToolRequest("forge_agent"), d1.next);
    const p2 = wrap(ctx, mockToolRequest("forge_agent"), d2.next);

    // 3rd spawn should fail — 2 are in flight
    try {
      await wrap(ctx, mockToolRequest("forge_agent"), () => Promise.resolve(mockToolResponse()));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("RATE_LIMIT");
        expect(e.retryable).toBe(true);
        expect(e.message).toContain("Max fan-out exceeded");
        expect(e.message).toContain("2/2");
      }
    }

    // Cleanup: resolve pending spawns
    d1.resolve();
    d2.resolve();
    await p1;
    await p2;
  });

  test("allows sequential spawns beyond fan-out limit", async () => {
    const guard = createSpawnGuard({ policy: { maxFanOut: 2 }, agentDepth: 0 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Sequential spawns: each completes before next starts, fan-out resets to 0
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("fan-out slot freed when concurrent child completes", async () => {
    const guard = createSpawnGuard({ policy: { maxFanOut: 1 }, agentDepth: 0 });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    // Start 1 concurrent spawn
    const d1 = deferredToolNext();
    const p1 = wrap(ctx, mockToolRequest("forge_agent"), d1.next);

    // 2nd spawn blocked — fan-out at 1/1
    try {
      await wrap(ctx, mockToolRequest("forge_agent"), () => Promise.resolve(mockToolResponse()));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
    }

    // Complete child 1 — fan-out back to 0
    d1.resolve();
    await p1;

    // Now spawn succeeds
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Independent limit enforcement
  // -------------------------------------------------------------------------

  test("depth and fan-out checked independently", async () => {
    const guard = createSpawnGuard({
      policy: { maxDepth: 1, maxFanOut: 1 },
      agentDepth: 0,
    });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    // Start 1 concurrent spawn
    const d1 = deferredToolNext();
    const p1 = wrap(ctx, mockToolRequest("forge_agent"), d1.next);

    // 2nd spawn blocked by fan-out (not total processes)
    try {
      await wrap(ctx, mockToolRequest("forge_agent"), () => Promise.resolve(mockToolResponse()));
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("RATE_LIMIT");
        expect(e.message).toContain("Max fan-out exceeded");
      }
    }

    d1.resolve();
    await p1;
  });

  // -------------------------------------------------------------------------
  // Optimistic locking — failure path (#8A, #9A)
  // -------------------------------------------------------------------------

  test("rolls back fan-out counter when next() throws", async () => {
    const guard = createSpawnGuard({ agentDepth: 0, policy: { maxFanOut: 2 } });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    const failingNext: ToolNext = mock(() => Promise.reject(new Error("spawn failed")));
    const succeedingNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));

    // Failing spawn should not consume fan-out
    await expect(wrap(ctx, mockToolRequest("forge_agent"), failingNext)).rejects.toThrow(
      "spawn failed",
    );

    // Both fan-out slots should still be available
    await wrap(ctx, mockToolRequest("forge_agent"), succeedingNext);
    await wrap(ctx, mockToolRequest("forge_agent"), succeedingNext);
    expect(succeedingNext).toHaveBeenCalledTimes(2);
  });

  test("multiple failures don't accumulate phantom counts", async () => {
    const guard = createSpawnGuard({ agentDepth: 0, policy: { maxFanOut: 5 } });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    const failingNext: ToolNext = mock(() => Promise.reject(new Error("fail")));

    // 5 failures should not consume any fan-out slots
    for (let i = 0; i < 5; i++) {
      await expect(wrap(ctx, mockToolRequest("forge_agent"), failingNext)).rejects.toThrow("fail");
    }

    // All fan-out slots should still be available after failures
    const succeedingNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    for (let i = 0; i < 5; i++) {
      await wrap(ctx, mockToolRequest("forge_agent"), succeedingNext);
    }
    expect(succeedingNext).toHaveBeenCalledTimes(5);
  });

  // -------------------------------------------------------------------------
  // Configurable spawn tool IDs (#5A)
  // -------------------------------------------------------------------------

  test("uses custom spawnToolIds", async () => {
    const guard = createSpawnGuard({
      policy: { spawnToolIds: ["forge_agent", "delegate_agent"], maxFanOut: 5 },
      agentDepth: 0,
    });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    // Both IDs should trigger spawn governance (use deferred to keep fan-out slots active)
    const d1 = deferredToolNext();
    const d2 = deferredToolNext();
    const p1 = wrap(ctx, mockToolRequest("forge_agent"), d1.next);
    const p2 = wrap(ctx, mockToolRequest("delegate_agent"), d2.next);

    // Non-spawn tool should pass through without fan-out impact
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    await wrap(ctx, mockToolRequest("calc"), next);

    d1.resolve();
    d2.resolve();
    await p1;
    await p2;
  });

  test("default spawnToolIds includes forge_agent", async () => {
    const guard = createSpawnGuard({ agentDepth: 0 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Warning thresholds (#7A)
  // -------------------------------------------------------------------------

  test("fires fan-out warning when concurrent children reach threshold", async () => {
    const warnings: unknown[] = [];
    const guard = createSpawnGuard({
      policy: {
        maxFanOut: 3,
        fanOutWarningAt: 2,
        onWarning: (info) => warnings.push(info),
      },
      agentDepth: 0,
    });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    // Start 2 concurrent spawns
    const d1 = deferredToolNext();
    const d2 = deferredToolNext();
    const p1 = wrap(ctx, mockToolRequest("forge_agent"), d1.next);
    const p2 = wrap(ctx, mockToolRequest("forge_agent"), d2.next);

    // Flush microtasks — warning fires after fan-out increment
    await new Promise((r) => setTimeout(r, 0));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      kind: "fan_out",
      current: 2,
      limit: 3,
      warningAt: 2,
    });

    d1.resolve();
    d2.resolve();
    await p1;
    await p2;
  });

  test("warning fires at most once per limit kind", async () => {
    const warnings: unknown[] = [];
    const guard = createSpawnGuard({
      policy: {
        maxFanOut: 5,
        fanOutWarningAt: 2,
        onWarning: (info) => warnings.push(info),
      },
      agentDepth: 0,
    });
    const wrap = getToolWrap(guard);
    const ctx = mockTurnContext();

    // Start 3 concurrent spawns — warning fires at 2, not again at 3
    const d1 = deferredToolNext();
    const d2 = deferredToolNext();
    const d3 = deferredToolNext();
    const p1 = wrap(ctx, mockToolRequest("forge_agent"), d1.next); // 1
    const p2 = wrap(ctx, mockToolRequest("forge_agent"), d2.next); // 2 — warning fires
    const p3 = wrap(ctx, mockToolRequest("forge_agent"), d3.next); // 3 — no duplicate

    // Flush microtasks — warnings fire after await ledger.acquire()
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings).toHaveLength(1);

    d1.resolve();
    d2.resolve();
    d3.resolve();
    await p1;
    await p2;
    await p3;
  });

  test("no warning when threshold not configured", async () => {
    const onWarning = mock(() => {});
    const guard = createSpawnGuard({
      policy: { onWarning },
      agentDepth: 0,
    });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(onWarning).not.toHaveBeenCalled();
  });

  test("throws VALIDATION if fanOutWarningAt >= maxFanOut", () => {
    try {
      createSpawnGuard({ policy: { fanOutWarningAt: 5, maxFanOut: 5 } });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("fanOutWarningAt");
      }
    }
  });

  // -------------------------------------------------------------------------
  // GovernanceController wiring (#3A)
  // -------------------------------------------------------------------------

  test("consults GovernanceController when agent is provided", async () => {
    const governance: GovernanceController = {
      check: (_variable: string): GovernanceCheck => ({
        ok: false,
        variable: "spawn_depth",
        reason: "Custom governance denies spawn",
        retryable: false,
      }),
      checkAll: () => ({ ok: true }),
      record: () => undefined,
      snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
      variables: () => new Map(),
      reading: () => undefined,
    };
    const agent = mockAgent(governance);
    const guard = createSpawnGuard({ agentDepth: 0, agent });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("PERMISSION");
        expect(e.message).toContain("Custom governance denies");
      }
    }
    expect(next).not.toHaveBeenCalled();
  });

  test("allows spawn when GovernanceController approves", async () => {
    const governance: GovernanceController = {
      check: (): GovernanceCheck => ({ ok: true }),
      checkAll: () => ({ ok: true }),
      record: () => undefined,
      snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
      variables: () => new Map(),
      reading: () => undefined,
    };
    const agent = mockAgent(governance);
    const guard = createSpawnGuard({ agentDepth: 0, agent });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("skips GovernanceController check when agent has no GOVERNANCE component", async () => {
    const agent = mockAgent(); // no governance controller
    const guard = createSpawnGuard({ agentDepth: 0, agent });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("works without agent (no GovernanceController check)", async () => {
    const guard = createSpawnGuard({ agentDepth: 0 });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Depth-based tool restrictions
  // -------------------------------------------------------------------------

  describe("toolRestrictions", () => {
    test("blocks restricted tool at matching depth", async () => {
      const guard = createSpawnGuard({
        agentDepth: 2,
        policy: { toolRestrictions: [{ toolId: "exec", minDepth: 2 }] },
      });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      try {
        await wrap(ctx, mockToolRequest("exec"), next);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        if (e instanceof KoiRuntimeError) {
          expect(e.code).toBe("PERMISSION");
          expect(e.message).toContain('"exec"');
          expect(e.message).toContain("depth 2");
        }
      }
      expect(next).not.toHaveBeenCalled();
    });

    test("allows tool when depth is below minDepth", async () => {
      const guard = createSpawnGuard({
        agentDepth: 1,
        policy: { toolRestrictions: [{ toolId: "exec", minDepth: 2 }] },
      });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      await wrap(ctx, mockToolRequest("exec"), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    test("blocks at depth greater than minDepth (endowment rule)", async () => {
      const guard = createSpawnGuard({
        agentDepth: 5,
        policy: { toolRestrictions: [{ toolId: "exec", minDepth: 2 }] },
      });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      try {
        await wrap(ctx, mockToolRequest("exec"), next);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        if (e instanceof KoiRuntimeError) {
          expect(e.code).toBe("PERMISSION");
        }
      }
    });

    test("does not affect unrestricted tools", async () => {
      const guard = createSpawnGuard({
        agentDepth: 3,
        policy: { toolRestrictions: [{ toolId: "exec", minDepth: 1 }] },
      });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      await wrap(ctx, mockToolRequest("calc"), next);
      await wrap(ctx, mockToolRequest("search"), next);
      expect(next).toHaveBeenCalledTimes(2);
    });

    test("multiple rules restrict different tools at different depths", async () => {
      const guard = createSpawnGuard({
        agentDepth: 1,
        policy: {
          toolRestrictions: [
            { toolId: "admin", minDepth: 1 },
            { toolId: "fs:write", minDepth: 2 },
          ],
        },
      });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      // admin blocked at depth 1
      try {
        await wrap(ctx, mockToolRequest("admin"), next);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        if (e instanceof KoiRuntimeError) {
          expect(e.code).toBe("PERMISSION");
        }
      }

      // fs:write allowed at depth 1 (minDepth is 2)
      await wrap(ctx, mockToolRequest("fs:write"), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    test("restriction on spawn tool blocks before spawn depth check", async () => {
      const guard = createSpawnGuard({
        agentDepth: 1,
        policy: {
          maxDepth: 5,
          toolRestrictions: [{ toolId: "forge_agent", minDepth: 1 }],
        },
      });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      try {
        await wrap(ctx, mockToolRequest("forge_agent"), next);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        if (e instanceof KoiRuntimeError) {
          // Should be tool restriction error, not depth error
          expect(e.code).toBe("PERMISSION");
          expect(e.message).toContain("not allowed at depth");
        }
      }
    });

    test("no restrictions when toolRestrictions is undefined", async () => {
      const guard = createSpawnGuard({ agentDepth: 5 });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      // Non-spawn tool should pass through without restriction
      await wrap(ctx, mockToolRequest("exec"), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    test("restriction at minDepth 0 blocks tool at root", async () => {
      const guard = createSpawnGuard({
        agentDepth: 0,
        policy: { toolRestrictions: [{ toolId: "dangerous", minDepth: 0 }] },
      });
      const wrap = getToolWrap(guard);
      const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
      const ctx = mockTurnContext();

      try {
        await wrap(ctx, mockToolRequest("dangerous"), next);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        if (e instanceof KoiRuntimeError) {
          expect(e.code).toBe("PERMISSION");
          expect(e.message).toContain("depth 0");
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// detectRepeatingPattern (unit)
// ---------------------------------------------------------------------------

describe("detectRepeatingPattern", () => {
  test("detects length-2 pattern (A,B,A,B)", () => {
    const hashes = [1, 2, 1, 2];
    expect(detectRepeatingPattern(hashes, 2, 2)).toBe(2);
  });

  test("detects length-3 pattern (A,B,C,A,B,C)", () => {
    const hashes = [1, 2, 3, 1, 2, 3];
    expect(detectRepeatingPattern(hashes, 2, 2)).toBe(3);
  });

  test("returns 0 when no pattern", () => {
    const hashes = [1, 2, 3, 4, 5];
    expect(detectRepeatingPattern(hashes, 2, 2)).toBe(0);
  });

  test("returns 0 when sequence too short", () => {
    const hashes = [1, 2];
    expect(detectRepeatingPattern(hashes, 2, 2)).toBe(0);
  });

  test("prefers shortest pattern length", () => {
    // [1,2,1,2,1,2] could be length-2 repeated 3x or length-3 repeated 2x
    const hashes = [1, 2, 1, 2, 1, 2];
    expect(detectRepeatingPattern(hashes, 2, 2)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createLoopDetector — ping-pong
// ---------------------------------------------------------------------------

describe("createLoopDetector — ping-pong", () => {
  test("A,B,A,B pattern is detected", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 10, // high repeat threshold so only ping-pong fires
      pingPongEnabled: true,
      pingPongMinPatternLength: 2,
      pingPongRepetitions: 2,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("toolA", { x: 1 }), next);
    await wrap(ctx, mockToolRequest("toolB", { x: 2 }), next);
    await wrap(ctx, mockToolRequest("toolA", { x: 1 }), next);

    try {
      await wrap(ctx, mockToolRequest("toolB", { x: 2 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("Ping-pong");
      }
    }
  });

  test("A,B,C,A,B,C pattern is detected", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 10,
      pingPongEnabled: true,
      pingPongMinPatternLength: 2,
      pingPongRepetitions: 2,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    await wrap(ctx, mockToolRequest("c", { v: 3 }), next);
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);

    try {
      await wrap(ctx, mockToolRequest("c", { v: 3 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.message).toContain("Ping-pong");
      }
    }
  });

  test("broken pattern passes", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 10,
      pingPongEnabled: true,
      pingPongMinPatternLength: 2,
      pingPongRepetitions: 2,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("a"), next);
    await wrap(ctx, mockToolRequest("b"), next);
    await wrap(ctx, mockToolRequest("a"), next);
    await wrap(ctx, mockToolRequest("c"), next); // breaks the pattern
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("all unique passes", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 10,
      pingPongEnabled: true,
      pingPongMinPatternLength: 2,
      pingPongRepetitions: 2,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    await wrap(ctx, mockToolRequest("c", { v: 3 }), next);
    await wrap(ctx, mockToolRequest("d", { v: 4 }), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("minPatternLength is respected", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 10,
      pingPongEnabled: true,
      pingPongMinPatternLength: 3, // requires at least 3-element pattern
      pingPongRepetitions: 2,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // A,B,A,B pattern of length 2 — should NOT trigger with minPatternLength=3
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("repetitions=3 requires 3 full cycles", async () => {
    const detector = createLoopDetector({
      windowSize: 12,
      threshold: 10,
      pingPongEnabled: true,
      pingPongMinPatternLength: 2,
      pingPongRepetitions: 3,
      noProgressEnabled: false,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // 2 cycles should pass
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    expect(next).toHaveBeenCalledTimes(4);

    // 3rd cycle should trigger
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    try {
      await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.message).toContain("Ping-pong");
      }
    }
  });

  test("disabled via config", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 10,
      pingPongEnabled: false,
      noProgressEnabled: false,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // A,B,A,B pattern should pass when ping-pong disabled
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    await wrap(ctx, mockToolRequest("a", { v: 1 }), next);
    await wrap(ctx, mockToolRequest("b", { v: 2 }), next);
    expect(next).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// createLoopDetector — no-progress
// ---------------------------------------------------------------------------

describe("createLoopDetector — no-progress", () => {
  test("3 identical outputs triggers detection", async () => {
    const detector = createLoopDetector({
      windowSize: 20,
      threshold: 20, // high so repeat doesn't fire
      pingPongEnabled: false,
      noProgressEnabled: true,
      noProgressThreshold: 3,
    });
    const wrap = getToolWrap(detector);
    const ctx = mockTurnContext();

    // Each call has different input but same output
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse("same-result")));

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);

    try {
      await wrap(ctx, mockToolRequest("calc", { a: 3 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("No-progress");
        expect(e.message).toContain("3 consecutive");
      }
    }
  });

  test("output change resets counter", async () => {
    const detector = createLoopDetector({
      windowSize: 20,
      threshold: 20,
      pingPongEnabled: false,
      noProgressEnabled: true,
      noProgressThreshold: 3,
    });
    const wrap = getToolWrap(detector);
    const ctx = mockTurnContext();
    let outputValue = "result-a";
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse(outputValue)));

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);

    // Change output — resets counter
    outputValue = "result-b";
    await wrap(ctx, mockToolRequest("calc", { a: 3 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 4 }), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("per-tool tracking", async () => {
    const detector = createLoopDetector({
      windowSize: 20,
      threshold: 20,
      pingPongEnabled: false,
      noProgressEnabled: true,
      noProgressThreshold: 3,
    });
    const wrap = getToolWrap(detector);
    const ctx = mockTurnContext();
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse("same")));

    // Interleave different tools — each should track independently
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("search", { q: "x" }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);
    await wrap(ctx, mockToolRequest("search", { q: "y" }), next);

    // calc has 2 identical outputs, search has 2 — neither at threshold 3
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("custom threshold", async () => {
    const detector = createLoopDetector({
      windowSize: 20,
      threshold: 20,
      pingPongEnabled: false,
      noProgressEnabled: true,
      noProgressThreshold: 5,
    });
    const wrap = getToolWrap(detector);
    const ctx = mockTurnContext();
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse("fixed")));

    // 4 calls with same output should pass (threshold is 5)
    for (let i = 0; i < 4; i++) {
      await wrap(ctx, mockToolRequest("calc", { a: i }), next);
    }
    expect(next).toHaveBeenCalledTimes(4);

    // 5th should trigger
    try {
      await wrap(ctx, mockToolRequest("calc", { a: 5 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.message).toContain("No-progress");
      }
    }
  });

  test("disabled via config", async () => {
    const detector = createLoopDetector({
      windowSize: 20,
      threshold: 20,
      pingPongEnabled: false,
      noProgressEnabled: false,
    });
    const wrap = getToolWrap(detector);
    const ctx = mockTurnContext();
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse("same")));

    // 5 identical outputs should pass when no-progress disabled
    for (let i = 0; i < 5; i++) {
      await wrap(ctx, mockToolRequest("calc", { a: i }), next);
    }
    expect(next).toHaveBeenCalledTimes(5);
  });

  test("error shape includes detectionKind", async () => {
    const detector = createLoopDetector({
      windowSize: 20,
      threshold: 20,
      pingPongEnabled: false,
      noProgressEnabled: true,
      noProgressThreshold: 2,
    });
    const wrap = getToolWrap(detector);
    const ctx = mockTurnContext();
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse("fixed")));

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);

    try {
      await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.context).toBeDefined();
        expect((e.context as Record<string, unknown>).detectionKind).toBe("no_progress");
      }
    }
  });

  test("different output structure resets counter", async () => {
    const detector = createLoopDetector({
      windowSize: 20,
      threshold: 20,
      pingPongEnabled: false,
      noProgressEnabled: true,
      noProgressThreshold: 3,
    });
    const wrap = getToolWrap(detector);
    const ctx = mockTurnContext();

    let callIndex = 0;
    const next: ToolNext = mock(() => {
      callIndex++;
      // Return different structure on 3rd call
      const output = callIndex === 3 ? { different: true } : "same";
      return Promise.resolve(mockToolResponse(output));
    });

    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 2 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 3 }), next); // different output, resets
    await wrap(ctx, mockToolRequest("calc", { a: 4 }), next); // back to "same", count=1

    expect(next).toHaveBeenCalledTimes(4);
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
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
      expect(e).toBeInstanceOf(KoiRuntimeError);
    }
  });
});

// ---------------------------------------------------------------------------
// IterationGuard — inactivity timeout
// ---------------------------------------------------------------------------

describe("createIterationGuard inactivity", () => {
  test("idle agent times out at inactivity threshold", async () => {
    const guard = createIterationGuard({ maxInactivityMs: 30, maxDurationMs: 5_000 });
    const wrap = getModelWrap(guard);
    const ctx = mockTurnContext();

    // First call succeeds (resets activity timer)
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    await wrap(ctx, mockModelRequest(), next);

    // Wait past the inactivity threshold
    await new Promise((r) => setTimeout(r, 50));

    // Second call: idle > 30ms, should throw inactivity timeout
    try {
      await wrap(ctx, mockModelRequest(), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Inactivity timeout");
      }
    }
  });

  test("active streaming resets inactivity timer on each chunk", async () => {
    // maxInactivityMs=40ms, but streaming yields chunks every ~10ms — should survive
    const guard = createIterationGuard({ maxInactivityMs: 40, maxDurationMs: 5_000 });
    const streamWrap = getStreamWrap(guard);
    const ctx = mockTurnContext();

    const slowStreamNext: StreamNext = () => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 10));
          yield { kind: "text_delta" as const, delta: `chunk-${i}` };
        }
        yield { kind: "done" as const, response: mockModelResponse() };
      },
    });

    // Total time ~50ms > inactivityMs of 40ms, but each chunk resets the timer
    const chunks = await collectChunks(streamWrap(ctx, mockModelRequest(), slowStreamNext));
    expect(chunks).toHaveLength(6); // 5 text_delta + 1 done
  });

  test("tool call resets inactivity timer", async () => {
    const guard = createIterationGuard({ maxInactivityMs: 40, maxDurationMs: 5_000 });
    const modelWrap = getModelWrap(guard);
    const toolWrap = getToolWrap(guard);
    const ctx = mockTurnContext();
    const modelNext: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const toolNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));

    // Model call succeeds
    await modelWrap(ctx, mockModelRequest(), modelNext);

    // Wait almost to the limit
    await new Promise((r) => setTimeout(r, 25));

    // Tool call resets the timer
    await toolWrap(ctx, mockToolRequest(), toolNext);

    // Wait again — timer was reset by tool call
    await new Promise((r) => setTimeout(r, 25));

    // Model call should succeed (inactivity timer reset by tool call above)
    await modelWrap(ctx, mockModelRequest(), modelNext);
    expect(modelNext).toHaveBeenCalledTimes(2);
  });

  test("wall-clock maxDurationMs still fires as hard cap even with activity", async () => {
    // maxDurationMs is very short, maxInactivityMs is long
    const guard = createIterationGuard({ maxDurationMs: 1, maxInactivityMs: 5_000 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return mockModelResponse();
    });
    const ctx = mockTurnContext();

    // First call succeeds (checkLimits at ~0ms, next takes ~10ms)
    await wrap(ctx, mockModelRequest(), next);

    // Second call: elapsed > 1ms, wall-clock fires at checkLimits
    try {
      await wrap(ctx, mockModelRequest(), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Duration limit exceeded");
      }
    }
  });

  test("onSessionStart resets inactivity timer", async () => {
    const guard = createIterationGuard({ maxInactivityMs: 30, maxDurationMs: 5_000 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockModelRequest(), next);

    // Wait past inactivity
    await new Promise((r) => setTimeout(r, 50));

    // Reset via session start
    await guard.onSessionStart?.(mockSessionContext());

    // Should succeed (timer reset)
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("inactivity disabled when maxInactivityMs is undefined", async () => {
    const guard = createIterationGuard({ maxInactivityMs: undefined, maxDurationMs: 5_000 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockModelRequest(), next);

    // Wait well past what would be an inactivity timeout
    await new Promise((r) => setTimeout(r, 50));

    // Should still succeed — no inactivity check
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("idle before tool call is rejected by checkLimits", async () => {
    const guard = createIterationGuard({ maxInactivityMs: 30, maxDurationMs: 5_000 });
    const modelWrap = getModelWrap(guard);
    const toolWrap = getToolWrap(guard);
    const ctx = mockTurnContext();
    const modelNext: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    const toolNext: ToolNext = mock(() => Promise.resolve(mockToolResponse()));

    // Model call succeeds and resets activity
    await modelWrap(ctx, mockModelRequest(), modelNext);

    // Wait past the inactivity threshold
    await new Promise((r) => setTimeout(r, 50));

    // Tool call should fail — checkLimits runs before touchActivity
    try {
      await toolWrap(ctx, mockToolRequest(), toolNext);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Inactivity timeout");
      }
    }
    // Tool should NOT have executed
    expect(toolNext).toHaveBeenCalledTimes(0);
  });

  test("slow non-streaming model call completes and resets activity", async () => {
    // A model call that blocks > inactivityMs should still succeed (side effects
    // committed). The inactivity limit applies at the *next* boundary.
    const guard = createIterationGuard({ maxInactivityMs: 30, maxDurationMs: 5_000 });
    const wrap = getModelWrap(guard);
    const ctx = mockTurnContext();
    const slowModelNext: ModelNext = mock(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return mockModelResponse();
    });

    // Slow call completes — activity reset after successful return
    const response = await wrap(ctx, mockModelRequest(), slowModelNext);
    expect(response.content).toBe("ok");

    // Immediate next call should succeed (activity was reset)
    const fastNext: ModelNext = mock(() => Promise.resolve(mockModelResponse()));
    await wrap(ctx, mockModelRequest(), fastNext);
    expect(fastNext).toHaveBeenCalledTimes(1);
  });

  test("slow tool call completes without being reclassified as timeout", async () => {
    // A tool that blocks > inactivityMs should still return its result.
    // Throwing post-await would discard committed side effects.
    const guard = createIterationGuard({ maxInactivityMs: 30, maxDurationMs: 5_000 });
    const toolWrap = getToolWrap(guard);
    const ctx = mockTurnContext();
    const slowToolNext: ToolNext = mock(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return mockToolResponse(99);
    });

    // Slow tool completes — result preserved
    const response = await toolWrap(ctx, mockToolRequest(), slowToolNext);
    expect(response.output).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Composed guards interaction
// ---------------------------------------------------------------------------

describe("composed guards interaction", () => {
  /**
   * Compose multiple guards into a single wrapToolCall chain,
   * mirroring how createKoi() assembles them.
   */
  function composeToolWraps(
    guards: readonly KoiMiddleware[],
    terminal: ToolNext,
  ): (req: ToolRequest) => Promise<ToolResponse> {
    const ctx = mockTurnContext();
    return (req: ToolRequest): Promise<ToolResponse> => {
      const dispatch = (i: number, r: ToolRequest): Promise<ToolResponse> => {
        const guard = guards[i];
        if (guard?.wrapToolCall === undefined) {
          return i < guards.length ? dispatch(i + 1, r) : terminal(r);
        }
        return guard.wrapToolCall(ctx, r, (next) => dispatch(i + 1, next));
      };
      return dispatch(0, req);
    };
  }

  /**
   * Compose multiple guards into a single wrapModelCall chain.
   */
  function composeModelWraps(
    guards: readonly KoiMiddleware[],
    terminal: ModelNext,
  ): (req: ModelRequest) => Promise<ModelResponse> {
    const ctx = mockTurnContext();
    return (req: ModelRequest): Promise<ModelResponse> => {
      const dispatch = (i: number, r: ModelRequest): Promise<ModelResponse> => {
        const guard = guards[i];
        if (guard?.wrapModelCall === undefined) {
          return i < guards.length ? dispatch(i + 1, r) : terminal(r);
        }
        return guard.wrapModelCall(ctx, r, (next) => dispatch(i + 1, next));
      };
      return dispatch(0, req);
    };
  }

  test("LoopDetector throw does not count as a turn in IterationGuard", async () => {
    const iterGuard = createIterationGuard({ maxTurns: 2 });
    const loopGuard = createLoopDetector({ windowSize: 4, threshold: 2 });

    // Compose: iteration guard wraps loop detector (iteration checks model, loop checks tools)
    const modelChain = composeModelWraps(
      [iterGuard],
      mock(() => Promise.resolve(mockModelResponse())),
    );
    const toolChain = composeToolWraps(
      [loopGuard],
      mock(() => Promise.resolve(mockToolResponse())),
    );

    // Trigger loop detection (2 identical tool calls → threshold 2 → throws)
    await toolChain(mockToolRequest("calc", { a: 1 }));
    try {
      await toolChain(mockToolRequest("calc", { a: 1 }));
      expect.unreachable("loop should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
      }
    }

    // IterationGuard should still allow 2 model calls (loop throw didn't count)
    await modelChain(mockModelRequest());
    await modelChain(mockModelRequest());

    // 3rd model call should throw (turns exhausted)
    await expect(modelChain(mockModelRequest())).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  test("IterationGuard throw does not affect LoopDetector window", async () => {
    const iterGuard = createIterationGuard({ maxTurns: 1 });
    const loopGuard = createLoopDetector({ windowSize: 4, threshold: 3 });

    const modelChain = composeModelWraps(
      [iterGuard],
      mock(() => Promise.resolve(mockModelResponse())),
    );
    const toolChain = composeToolWraps(
      [loopGuard],
      mock(() => Promise.resolve(mockToolResponse())),
    );

    // Use up the iteration budget
    await modelChain(mockModelRequest());
    await expect(modelChain(mockModelRequest())).rejects.toBeInstanceOf(KoiRuntimeError);

    // LoopDetector should still be tracking independently —
    // 2 calls with same args should be under threshold 3
    await toolChain(mockToolRequest("calc", { a: 1 }));
    await toolChain(mockToolRequest("calc", { a: 1 }));
    // Both should succeed (count=2, threshold=3)
  });

  test("IterationGuard and LoopDetector both active on same request flow", async () => {
    createIterationGuard({ maxTurns: 10 });
    const loopGuard = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      noProgressEnabled: false,
    });

    const toolChain = composeToolWraps(
      [loopGuard],
      mock(() => Promise.resolve(mockToolResponse())),
    );

    // Varied tool calls should pass both guards
    await toolChain(mockToolRequest("calc", { a: 1 }));
    await toolChain(mockToolRequest("calc", { a: 2 }));
    await toolChain(mockToolRequest("search", { q: "hello" }));
    await toolChain(mockToolRequest("calc", { a: 3 }));

    // Repeated calls should trigger loop detector, not iteration guard
    await toolChain(mockToolRequest("search", { q: "same" }));
    await toolChain(mockToolRequest("search", { q: "same" }));
    try {
      await toolChain(mockToolRequest("search", { q: "same" }));
      expect.unreachable("loop should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Loop detected");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// onSessionStart — guard state reset across sessions
// ---------------------------------------------------------------------------

describe("onSessionStart resets guard state", () => {
  test("iteration guard resets turns and tokens across sessions", async () => {
    const guard = createIterationGuard({ maxTurns: 2, maxTokens: 200 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(() =>
      Promise.resolve(mockModelResponse({ inputTokens: 30, outputTokens: 20 })),
    );
    const ctx = mockTurnContext();

    // Session 1: consume 2 turns (turns counter = 2 after trackUsage)
    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);

    // Without reset, next call would throw (turns=2 >= maxTurns=2)
    // Reset via onSessionStart
    await guard.onSessionStart?.(mockSessionContext());

    // Session 2: should start fresh — 2 more turns succeed
    await wrap(ctx, mockModelRequest(), next);
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(4);

    // 3rd call in session 2 hits the limit (turns=2 >= maxTurns=2)
    try {
      await wrap(ctx, mockModelRequest(), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("TIMEOUT");
        expect(e.message).toContain("Max turns exceeded");
      }
    }
  });

  test("iteration guard resets duration timer across sessions", async () => {
    const guard = createIterationGuard({ maxDurationMs: 50 });
    const wrap = getModelWrap(guard);
    const next: ModelNext = mock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return mockModelResponse();
    });
    const ctx = mockTurnContext();

    // Session 1: one slow call (30ms elapsed)
    await wrap(ctx, mockModelRequest(), next);

    // Wait to exceed the 50ms budget from original startedAt
    await new Promise((r) => setTimeout(r, 30));

    // Reset via onSessionStart — refreshes startedAt
    await guard.onSessionStart?.(mockSessionContext());

    // Session 2: should succeed (fresh timer)
    await wrap(ctx, mockModelRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("loop detector resets state across sessions", async () => {
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 3,
      noProgressEnabled: false,
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Session 1: 2 identical calls (below threshold of 3)
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);

    // Reset via onSessionStart
    await detector.onSessionStart?.(mockSessionContext());

    // Session 2: 2 more identical calls — without reset, this would be 4 (over threshold)
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(next).toHaveBeenCalledTimes(4);

    // 3rd call in session 2 hits the threshold
    await expect(wrap(ctx, mockToolRequest("calc", { a: 1 }), next)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });

  test("loop detector resets warnings across sessions", async () => {
    const warnings: unknown[] = [];
    const detector = createLoopDetector({
      windowSize: 8,
      threshold: 4,
      warningThreshold: 2,
      noProgressEnabled: false,
      onWarning: (info) => warnings.push(info),
    });
    const wrap = getToolWrap(detector);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Session 1: trigger warning
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(warnings).toHaveLength(1);

    // Reset
    await detector.onSessionStart?.(mockSessionContext());

    // Session 2: same hash should fire warning again (firedWarnings was cleared)
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    await wrap(ctx, mockToolRequest("calc", { a: 1 }), next);
    expect(warnings).toHaveLength(2);
  });

  test("spawn guard resets fan-out warning across sessions", async () => {
    const warnings: unknown[] = [];
    const guard = createSpawnGuard({
      policy: {
        maxFanOut: 5,
        fanOutWarningAt: 1,
        onWarning: (info) => warnings.push(info),
      },
    });
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    // Session 1: trigger fan-out warning (use default spawn tool id "forge_agent")
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(warnings).toHaveLength(1);

    // Reset
    await guard.onSessionStart?.(mockSessionContext());

    // Session 2: warning should fire again
    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(warnings).toHaveLength(2);
  });
});

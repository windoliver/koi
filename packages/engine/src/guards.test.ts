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
import {
  createIterationGuard,
  createLoopDetector,
  createSpawnGuard,
  detectRepeatingPattern,
  fnv1a,
} from "./guards.js";

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

  test("throws KoiEngineError when duration limit exceeded", async () => {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("VALIDATION");
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
      expect(e).toBeInstanceOf(KoiEngineError);
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("VALIDATION");
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
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
// Spawn guard — shared accounter
// ---------------------------------------------------------------------------

describe("createSpawnGuard — shared accounter", () => {
  test("uses accounter for total process check", async () => {
    const accounter = {
      activeCount: mock(() => 5),
      increment: mock(() => {}),
      decrement: mock(() => {}),
    };
    const guard = createSpawnGuard({ maxTotalProcesses: 10 }, 0, accounter);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);
    expect(accounter.activeCount).toHaveBeenCalled();
    expect(accounter.increment).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("throws when accounter reports processes at limit", async () => {
    const accounter = {
      activeCount: mock(() => 5),
      increment: mock(() => {}),
      decrement: mock(() => {}),
    };
    const guard = createSpawnGuard({ maxTotalProcesses: 5 }, 0, accounter);
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
        expect(e.message).toContain("Max total processes exceeded");
      }
    }
    expect(accounter.increment).not.toHaveBeenCalled();
  });

  test("falls back to local counting without accounter", async () => {
    // No accounter — should use local counting (existing behavior)
    const guard = createSpawnGuard({ maxTotalProcesses: 2 }, 0);
    const wrap = getToolWrap(guard);
    const next: ToolNext = mock(() => Promise.resolve(mockToolResponse()));
    const ctx = mockTurnContext();

    await wrap(ctx, mockToolRequest("forge_agent"), next);

    try {
      await wrap(ctx, mockToolRequest("forge_agent"), next);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("PERMISSION");
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

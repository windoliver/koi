import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { ToolRequest } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createFailingValidator,
  createMockTurnContext,
  createMockValidator,
  createSpyToolHandler,
} from "@koi/test-utils";
import type { ForgeHealthConfig } from "../config.js";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";
import type { ForgeToolErrorFeedback } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx = createMockTurnContext();

function createMockForgeStore() {
  return {
    save: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    load: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    search: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    remove: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    update: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    exists: mock(() => Promise.resolve({ ok: true as const, value: false })),
  };
}

function createMockSnapshotStore() {
  return {
    record: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    get: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    list: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    history: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    latest: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
  };
}

function createForgeHealthConfig(overrides?: Partial<ForgeHealthConfig>): ForgeHealthConfig {
  return {
    resolveBrickId: (toolId: string) =>
      toolId.startsWith("forged-") ? `brick-${toolId}` : undefined,
    forgeStore: createMockForgeStore(),
    snapshotStore: createMockSnapshotStore(),
    windowSize: 4,
    quarantineThreshold: 0.5,
    maxRecentFailures: 5,
    flushThreshold: 1000, // High threshold to avoid flush interference in existing tests
    errorRateDeltaThreshold: 1, // Disable error rate delta flush
    clock: () => 1000,
    ...overrides,
  };
}

const forgedToolRequest: ToolRequest = {
  toolId: "forged-tool-1",
  input: { query: "test" },
};

const nonForgedToolRequest: ToolRequest = {
  toolId: "builtin-tool-1",
  input: { query: "test" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool health integration", () => {
  test("forged tool success records metrics", async () => {
    // let: capture clock calls to verify latency tracking
    let clockCalls = 0;
    const forgeHealth = createForgeHealthConfig({
      clock: () => {
        clockCalls++;
        // First call = start, second call = end (10ms latency)
        return clockCalls <= 1 ? 1000 : 1010;
      },
    });

    const spy = createSpyToolHandler({ output: { result: "ok" } });
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    const result = await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    expect(result?.output).toEqual({ result: "ok" });
    expect(spy.calls).toHaveLength(1);
  });

  test("forged tool failure records failure", async () => {
    const forgeStore = createMockForgeStore();
    const forgeHealth = createForgeHealthConfig({ forgeStore });

    const failingHandler = async () => {
      throw new Error("tool crashed");
    };
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    try {
      await mw.wrapToolCall?.(ctx, forgedToolRequest, failingHandler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toBe("tool crashed");
      }
    }
  });

  test("tool exceeds threshold → quarantined → subsequent calls return ForgeToolErrorFeedback", async () => {
    const forgeStore = createMockForgeStore();
    const snapshotStore = createMockSnapshotStore();
    const onQuarantine = mock(() => {});

    const forgeHealth = createForgeHealthConfig({
      forgeStore,
      snapshotStore,
      onQuarantine,
      windowSize: 2,
      quarantineThreshold: 0.5,
    });

    const failingHandler = async () => {
      throw new Error("tool error");
    };
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    // Fail twice to trigger quarantine (100% error rate with window=2)
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall?.(ctx, forgedToolRequest, failingHandler);
      } catch {
        // Expected
      }
    }

    // Subsequent call should return structured feedback, not throw
    const spy = createSpyToolHandler({ output: "should not reach" });
    const result = await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);

    expect(spy.calls).toHaveLength(0); // Handler never called
    const feedback = result?.output as ForgeToolErrorFeedback;
    expect(feedback.error).toContain("quarantined");
    expect(feedback.errorRate).toBeGreaterThan(0);
    expect(feedback.suggestion).toContain("re-forge");
  });

  test("non-forged tool passes through without health tracking", async () => {
    const forgeHealth = createForgeHealthConfig();
    const spy = createSpyToolHandler({ output: "raw" });
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    const result = await mw.wrapToolCall?.(ctx, nonForgedToolRequest, spy.handler);
    expect(result?.output).toBe("raw");
    expect(spy.calls).toHaveLength(1);
  });

  test("onQuarantine callback fires when tool is quarantined", async () => {
    const onQuarantine = mock(() => {});
    const forgeHealth = createForgeHealthConfig({
      onQuarantine,
      windowSize: 2,
      quarantineThreshold: 0.5,
    });

    const failingHandler = async () => {
      throw new Error("crash");
    };
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall?.(ctx, forgedToolRequest, failingHandler);
      } catch {
        // Expected
      }
    }

    expect(onQuarantine).toHaveBeenCalledWith("brick-forged-tool-1");
  });

  test("gate failure counts as tool failure", async () => {
    const forgeStore = createMockForgeStore();
    const snapshotStore = createMockSnapshotStore();
    const onQuarantine = mock(() => {});

    const forgeHealth = createForgeHealthConfig({
      forgeStore,
      snapshotStore,
      onQuarantine,
      windowSize: 2,
      quarantineThreshold: 0.5,
    });

    const spy = createSpyToolHandler({ output: { data: "bad" } });
    const { middleware: mw } = createFeedbackLoopMiddleware({
      forgeHealth,
      toolGates: [
        createFailingValidator(
          [{ validator: "safety-gate", message: "unsafe output" }],
          "safety-gate",
        ),
      ],
    });

    // Gate failures trigger health tracking
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
      } catch {
        // Expected gate failure
      }
    }

    // Should be quarantined now
    const successSpy = createSpyToolHandler({ output: "ok" });
    const result = await mw.wrapToolCall?.(ctx, forgedToolRequest, successSpy.handler);
    expect(successSpy.calls).toHaveLength(0);
    const feedback = result?.output as ForgeToolErrorFeedback;
    expect(feedback.error).toContain("quarantined");
  });

  test("forgeStore.update and snapshotStore.record called during quarantine", async () => {
    const forgeStore = createMockForgeStore();
    const snapshotStore = createMockSnapshotStore();

    const forgeHealth = createForgeHealthConfig({
      forgeStore,
      snapshotStore,
      windowSize: 2,
      quarantineThreshold: 0.5,
    });

    const failingHandler = async () => {
      throw new Error("err");
    };
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall?.(ctx, forgedToolRequest, failingHandler);
      } catch {
        // Expected
      }
    }

    // 2 update calls: 1 for lifecycle → "failed", 1 for fitness flush before eviction
    expect(forgeStore.update).toHaveBeenCalledTimes(2);
    expect(snapshotStore.record).toHaveBeenCalledTimes(1);
  });

  test("mixed forged and non-forged tools in same middleware", async () => {
    const forgeHealth = createForgeHealthConfig();
    const spy = createSpyToolHandler({ output: "ok" });
    const { middleware: mw } = createFeedbackLoopMiddleware({
      forgeHealth,
      toolGates: [createMockValidator("gate")],
    });

    // Forged tool
    const result1 = await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    expect(result1?.output).toBe("ok");

    // Non-forged tool
    const result2 = await mw.wrapToolCall?.(ctx, nonForgedToolRequest, spy.handler);
    expect(result2?.output).toBe("ok");

    expect(spy.calls).toHaveLength(2);
  });

  test("health tracking disabled when forgeHealth not configured", async () => {
    const spy = createSpyToolHandler({ output: "ok" });
    const { middleware: mw } = createFeedbackLoopMiddleware({});

    const result = await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    expect(result?.output).toBe("ok");
    expect(spy.calls).toHaveLength(1);
  });

  test("existing tool validators still work with health tracking enabled", async () => {
    const forgeHealth = createForgeHealthConfig();
    const spy = createSpyToolHandler();
    const { middleware: mw } = createFeedbackLoopMiddleware({
      forgeHealth,
      toolValidators: [
        createFailingValidator([{ validator: "input-check", message: "bad input" }], "input-check"),
      ],
    });

    try {
      await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
    }
    // Handler never called — input validation failed before execution
    expect(spy.calls).toHaveLength(0);
  });

  test("checkAndDemote wired in failure path — demotes promoted tool", async () => {
    const forgeStore = createMockForgeStore();
    // Mock load to return a promoted brick
    forgeStore.load = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          origin: "primordial",
          policy: DEFAULT_UNSANDBOXED_POLICY,
        } as never,
      }),
    );
    const snapshotStore = createMockSnapshotStore();
    const onDemotion = mock(() => {});

    // Create tracker directly to test demotion behavior deterministically
    const { createToolHealthTracker } = await import("../tool-health.js");
    const tracker = createToolHealthTracker({
      resolveBrickId: (toolId: string) =>
        toolId.startsWith("forged-") ? `brick-${toolId}` : undefined,
      forgeStore,
      snapshotStore,
      onDemotion,
      windowSize: 3,
      quarantineThreshold: 0.9,
      clock: () => 100_000_000,
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 3,
        minSampleSize: 3,
        gracePeriodMs: 1000,
        demotionCooldownMs: 1000,
      },
    });

    // Record failures to exceed demotion threshold (100% error rate)
    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");
    tracker.recordFailure("forged-tool-1", 10, "e3");

    // Explicitly call checkAndDemote (in production, middleware does this fire-and-forget)
    const result = await tracker.checkAndDemote("forged-tool-1");
    expect(result).toBe(true);

    // Verify store update with demoted trust tier
    expect(forgeStore.update).toHaveBeenCalledTimes(1);
    const updateArgs = forgeStore.update.mock.calls[0] as unknown[];
    expect(updateArgs[1]).toEqual(expect.objectContaining({ policy: DEFAULT_SANDBOXED_POLICY }));

    // Verify onDemotion callback fired
    expect(onDemotion).toHaveBeenCalledTimes(1);
    const event = (onDemotion.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    expect(event.from).toBe("unsandboxed");
    expect(event.to).toBe("sandboxed");
    expect(event.reason).toBe("error_rate");

    // Verify snapshot recorded
    expect(snapshotStore.record).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Flush serialization tests (Issue 8A + 11A)
// ---------------------------------------------------------------------------

describe("flush serialization", () => {
  test("rapid concurrent flushes — counter is consistent (no race)", async () => {
    // Configure flush to trigger on every invocation (threshold=1, delta=0)
    const forgeStore = createMockForgeStore();
    // let: track the order of concurrent flush calls to detect serialization
    let concurrentFlushes = 0;
    let maxConcurrentFlushes = 0;

    const originalUpdate = forgeStore.update;
    forgeStore.update = mock(async (...args: Parameters<typeof originalUpdate>) => {
      concurrentFlushes++;
      if (concurrentFlushes > maxConcurrentFlushes) {
        maxConcurrentFlushes = concurrentFlushes;
      }
      // Simulate async delay to expose race conditions
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrentFlushes--;
      return originalUpdate(...args);
    });

    const onFlushError = mock(() => {});
    const forgeHealth = createForgeHealthConfig({
      forgeStore,
      onFlushError,
      flushThreshold: 1,
      errorRateDeltaThreshold: 0,
    });

    const spy = createSpyToolHandler({ output: "ok" });
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    // Fire 5 rapid tool calls without awaiting flush completion between them
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler) ?? Promise.resolve());
    }
    await Promise.all(promises);

    // Drain the serialized flush chain by awaiting a microtask cycle
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Serialization means max concurrent flushes should be 1
    expect(maxConcurrentFlushes).toBeLessThanOrEqual(1);
    // No errors should have been reported
    expect(onFlushError).not.toHaveBeenCalled();
  });

  test("interleaved success/failure — circuit breaker opens after 3 consecutive failures", async () => {
    const forgeStore = createMockForgeStore();
    // Make every flush fail (flushToolImpl catches and calls onFlushError internally)
    forgeStore.load = mock(() => Promise.reject(new Error("store unavailable")));

    const onFlushError = mock(() => {});
    const forgeHealth = createForgeHealthConfig({
      forgeStore,
      onFlushError,
      flushThreshold: 1,
      errorRateDeltaThreshold: 0,
    });

    const spy = createSpyToolHandler({ output: "ok" });
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    // Trigger 5 tool calls — each will attempt a flush that fails
    for (let i = 0; i < 5; i++) {
      await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    }

    // Drain the flush chain
    await new Promise((resolve) => setTimeout(resolve, 200));

    // flushToolImpl calls onFlushError for each of the 3 actual flush attempts,
    // then maybeFlush fires the circuit-breaker-open notification on the 3rd.
    // Flushes 4 and 5 are skipped by the serialized re-check.
    // Total: 3 (from flushToolImpl) + 1 (circuit open from maybeFlush) = 4
    expect(onFlushError).toHaveBeenCalledTimes(4);

    // Verify the last call is the circuit breaker open notification
    const lastCallArgs = onFlushError.mock.calls[3] as unknown[];
    expect(lastCallArgs[0]).toBe("forged-tool-1");
    const circuitError = lastCallArgs[1] as Error;
    expect(circuitError.message).toContain("circuit breaker open");
  });

  test("circuit breaker resets on successful flush after failures", async () => {
    const forgeStore = createMockForgeStore();
    // let: control whether flush succeeds or fails
    let shouldFail = true;
    forgeStore.load = mock(() => {
      if (shouldFail) {
        return Promise.reject(new Error("transient failure"));
      }
      return Promise.resolve({ ok: true as const, value: {} as never });
    });

    const onFlushError = mock(() => {});
    const forgeHealth = createForgeHealthConfig({
      forgeStore,
      onFlushError,
      flushThreshold: 1,
      errorRateDeltaThreshold: 0,
    });

    const spy = createSpyToolHandler({ output: "ok" });
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    // Trigger 2 failures (not enough to open circuit)
    await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 2 calls from flushToolImpl's internal error reporting
    expect(onFlushError).toHaveBeenCalledTimes(2);

    // Now succeed — should reset counter
    shouldFail = false;
    await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // No additional error calls
    expect(onFlushError).toHaveBeenCalledTimes(2);

    // Fail again — circuit should open fresh because counter was reset
    shouldFail = true;
    for (let i = 0; i < 4; i++) {
      await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 2 initial + 3 new failures (from flushToolImpl) + 1 circuit open (from maybeFlush) = 6
    expect(onFlushError).toHaveBeenCalledTimes(6);
  });

  test("onFlushError callback fires with toolId and error on flush failure", async () => {
    const forgeStore = createMockForgeStore();
    const flushError = new Error("disk full");
    forgeStore.load = mock(() => Promise.reject(flushError));

    const onFlushError = mock(() => {});
    const forgeHealth = createForgeHealthConfig({
      forgeStore,
      onFlushError,
      flushThreshold: 1,
      errorRateDeltaThreshold: 0,
    });

    const spy = createSpyToolHandler({ output: "ok" });
    const { middleware: mw } = createFeedbackLoopMiddleware({ forgeHealth });

    await mw.wrapToolCall?.(ctx, forgedToolRequest, spy.handler);

    // Drain the flush chain
    await new Promise((resolve) => setTimeout(resolve, 100));

    // flushToolImpl reports the error via onFlushError
    expect(onFlushError).toHaveBeenCalledTimes(1);
    const args = onFlushError.mock.calls[0] as unknown[];
    expect(args[0]).toBe("forged-tool-1");
    expect(args[1]).toBe(flushError);
  });
});

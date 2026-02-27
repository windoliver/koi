import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core/errors";
import type { ModelRequest } from "@koi/core/middleware";
import {
  createMockModelStreamHandler,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyModelStreamHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createPayMiddleware } from "./pay.js";
import { createDefaultCostCalculator, createInMemoryBudgetTracker } from "./tracker.js";

describe("createPayMiddleware", () => {
  const ctx = createMockTurnContext();

  function makeMiddleware(
    budget: number,
    options?: {
      readonly hardKill?: boolean;
      readonly alertThresholds?: readonly number[];
      readonly onAlert?: (pctUsed: number, remaining: number) => void;
    },
  ): ReturnType<typeof createPayMiddleware> {
    return createPayMiddleware({
      tracker: createInMemoryBudgetTracker(),
      calculator: createDefaultCostCalculator(),
      budget,
      ...options,
    });
  }

  test("has name 'pay'", () => {
    const mw = makeMiddleware(10);
    expect(mw.name).toBe("pay");
  });

  test("has priority 200", () => {
    const mw = makeMiddleware(10);
    expect(mw.priority).toBe(200);
  });

  test("model call records cost", async () => {
    const tracker = createInMemoryBudgetTracker();
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 10,
    });
    const spy = createSpyModelHandler({
      content: "hello",
      model: "test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    const total = await tracker.totalSpend("session-test-1");
    expect(total).toBeGreaterThan(0);
  });

  test("model call returns response from next()", async () => {
    const mw = makeMiddleware(10);
    const spy = createSpyModelHandler({ content: "hello world" });
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(response?.content).toBe("hello world");
  });

  test("next() is called with original request", async () => {
    const mw = makeMiddleware(10);
    const spy = createSpyModelHandler();
    const request: ModelRequest = { messages: [], model: "gpt-4" };
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    expect(spy.calls[0]).toBe(request);
  });

  test("budget exceeded throws RATE_LIMIT", async () => {
    const tracker = createInMemoryBudgetTracker();
    // Pre-fill the budget
    await tracker.record("session-test-1", {
      inputTokens: 0,
      outputTokens: 0,
      model: "test",
      costUsd: 10,
      timestamp: Date.now(),
    });
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 10,
    });
    const spy = createSpyModelHandler();
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("RATE_LIMIT");
      expect(err.retryable).toBe(true);
    }
  });

  test("next() NOT called when budget exceeded", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("session-test-1", {
      inputTokens: 0,
      outputTokens: 0,
      model: "test",
      costUsd: 10,
      timestamp: Date.now(),
    });
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 10,
    });
    const spy = createSpyModelHandler();
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    } catch {
      // expected
    }
    expect(spy.calls).toHaveLength(0);
  });

  test("hardKill=false allows over-budget calls", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("session-test-1", {
      inputTokens: 0,
      outputTokens: 0,
      model: "test",
      costUsd: 10,
      timestamp: Date.now(),
    });
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 10,
      hardKill: false,
    });
    const spy = createSpyModelHandler();
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.content).toBe("mock response");
  });

  test("zero-budget blocks immediately", async () => {
    const mw = createPayMiddleware({
      tracker: createInMemoryBudgetTracker(),
      calculator: createDefaultCostCalculator(),
      budget: 0,
    });
    const spy = createSpyModelHandler();
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("RATE_LIMIT");
    }
  });

  test("threshold alerts fire at correct percentage", async () => {
    const tracker = createInMemoryBudgetTracker();
    const alerts: Array<{ readonly pct: number; readonly rem: number }> = [];
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator({
        "test-model": { input: 0.01, output: 0.01 },
      }),
      budget: 1.0,
      alertThresholds: [0.5],
      onAlert: (pct, rem) => {
        alerts.push({ pct, rem });
      },
    });
    // First call should be ~$1.5 which is 150% => fires 50% threshold
    const spy = createSpyModelHandler({
      content: "hi",
      model: "test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]?.pct).toBeGreaterThanOrEqual(0.5);
  });

  test("tool call pre-checks budget", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("session-test-1", {
      inputTokens: 0,
      outputTokens: 0,
      model: "test",
      costUsd: 10,
      timestamp: Date.now(),
    });
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 10,
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, { toolId: "calc", input: {} }, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("RATE_LIMIT");
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("tool call passes through when within budget", async () => {
    const mw = makeMiddleware(10);
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, { toolId: "calc", input: {} }, spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("onUsage fires with cost entry after model call", async () => {
    const tracker = createInMemoryBudgetTracker();
    const usages: Array<{ readonly totalSpent: number; readonly remaining: number }> = [];
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator({
        "test-model": { input: 0.01, output: 0.01 },
      }),
      budget: 10,
      onUsage: (info) => {
        usages.push({ totalSpent: info.totalSpent, remaining: info.remaining });
      },
    });
    const spy = createSpyModelHandler({
      content: "hi",
      model: "test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(usages).toHaveLength(1);
    expect(usages[0]?.totalSpent).toBeGreaterThan(0);
    expect(usages[0]?.remaining).toBeLessThan(10);
  });

  test("onUsage not fired when response has no usage", async () => {
    let called = false;
    const mw = createPayMiddleware({
      tracker: createInMemoryBudgetTracker(),
      calculator: createDefaultCostCalculator(),
      budget: 10,
      onUsage: () => {
        called = true;
      },
    });
    const noUsageHandler = async (): Promise<import("@koi/core/middleware").ModelResponse> => ({
      content: "hi",
      model: "test",
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, noUsageHandler);
    expect(called).toBe(false);
  });

  test("response without usage does not record cost", async () => {
    const tracker = createInMemoryBudgetTracker();
    const mw = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 10,
    });
    const noUsageHandler = async (): Promise<import("@koi/core/middleware").ModelResponse> => ({
      content: "hi",
      model: "test",
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, noUsageHandler);
    expect(await tracker.totalSpend("session-test-1")).toBe(0);
  });

  describe("wrapModelStream", () => {
    async function drainStream(iter: AsyncIterable<unknown>): Promise<void> {
      for await (const _ of iter) {
        /* drain */
      }
    }

    // Unwrap the optional wrapModelStream method, throwing if not implemented.
    function streamOf(
      mw: ReturnType<typeof createPayMiddleware>,
    ): NonNullable<(typeof mw)["wrapModelStream"]> {
      const fn = mw.wrapModelStream;
      if (!fn) throw new Error("wrapModelStream not defined on pay middleware");
      return fn;
    }

    test("passes chunks through unchanged", async () => {
      const mw = makeMiddleware(10);
      const spy = createSpyModelStreamHandler([
        { kind: "text_delta", delta: "hello" },
        { kind: "done", response: { content: "hello", model: "test-model" } },
      ]);

      const collected: string[] = [];
      for await (const chunk of streamOf(mw)(ctx, { messages: [] }, spy.handler)) {
        if (chunk.kind === "text_delta") collected.push(chunk.delta);
      }
      expect(collected).toEqual(["hello"]);
      expect(spy.calls).toHaveLength(1);
    });

    test("records cost from done chunk usage", async () => {
      const tracker = createInMemoryBudgetTracker();
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.01, output: 0.02 },
        }),
        budget: 10,
      });
      const handler = createMockModelStreamHandler([
        {
          kind: "done",
          response: {
            content: "ok",
            model: "test-model",
            usage: { inputTokens: 100, outputTokens: 50 },
          },
        },
      ]);

      await drainStream(streamOf(mw)(ctx, { messages: [] }, handler));
      const total = await tracker.totalSpend("session-test-1");
      // 100 * 0.01 + 50 * 0.02 = 1.00 + 1.00 = 2.00
      expect(total).toBeCloseTo(2.0);
    });

    test("budget exhausted blocks stream before LLM call", async () => {
      const tracker = createInMemoryBudgetTracker();
      await tracker.record("session-test-1", {
        inputTokens: 1000,
        outputTokens: 1000,
        model: "x",
        costUsd: 100,
        timestamp: Date.now(),
      });
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator(),
        budget: 1, // already exceeded
      });
      const spy = createSpyModelStreamHandler([
        { kind: "done", response: { content: "ok", model: "test-model" } },
      ]);

      await expect(drainStream(streamOf(mw)(ctx, { messages: [] }, spy.handler))).rejects.toThrow();
      expect(spy.calls).toHaveLength(0); // next() never called
    });

    test("zero-budget blocks stream immediately", async () => {
      const mw = createPayMiddleware({
        tracker: createInMemoryBudgetTracker(),
        calculator: createDefaultCostCalculator(),
        budget: 0,
      });
      const spy = createSpyModelStreamHandler([
        { kind: "done", response: { content: "ok", model: "test-model" } },
      ]);

      await expect(drainStream(streamOf(mw)(ctx, { messages: [] }, spy.handler))).rejects.toThrow();
      expect(spy.calls).toHaveLength(0);
    });

    test("hardKill=false allows over-budget stream", async () => {
      const tracker = createInMemoryBudgetTracker();
      await tracker.record("session-test-1", {
        inputTokens: 1000,
        outputTokens: 1000,
        model: "x",
        costUsd: 100,
        timestamp: Date.now(),
      });
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator(),
        budget: 1,
        hardKill: false,
      });
      const handler = createMockModelStreamHandler([
        { kind: "done", response: { content: "ok", model: "test-model" } },
      ]);

      await expect(
        drainStream(streamOf(mw)(ctx, { messages: [] }, handler)),
      ).resolves.toBeUndefined();
    });

    test("done chunk without usage does not record cost", async () => {
      const tracker = createInMemoryBudgetTracker();
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator(),
        budget: 10,
      });
      const handler = createMockModelStreamHandler([
        { kind: "done", response: { content: "ok", model: "test-model" } }, // no usage
      ]);

      await drainStream(streamOf(mw)(ctx, { messages: [] }, handler));
      expect(await tracker.totalSpend("session-test-1")).toBe(0);
    });

    test("threshold alert fires after stream completes", async () => {
      const tracker = createInMemoryBudgetTracker();
      const alerts: number[] = [];
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.001, output: 0.001 },
        }),
        budget: 1,
        alertThresholds: [0.5],
        onAlert: (pct) => {
          alerts.push(pct);
        },
      });
      // Spend 60% via stream
      const handler = createMockModelStreamHandler([
        {
          kind: "done",
          response: {
            content: "ok",
            model: "test-model",
            usage: { inputTokens: 300, outputTokens: 300 },
          },
        },
      ]);

      await drainStream(streamOf(mw)(ctx, { messages: [] }, handler));
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = makeMiddleware(5);
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'budget' and description containing budget value", () => {
      const mw = makeMiddleware(25);
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("budget");
      expect(result?.description).toContain("25");
    });
  });
});

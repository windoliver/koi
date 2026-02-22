import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core/errors";
import type { ModelRequest } from "@koi/core/middleware";
import {
  createMockTurnContext,
  createSpyModelHandler,
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
});

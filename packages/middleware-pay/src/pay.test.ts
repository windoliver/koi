import { describe, expect, test } from "bun:test";
import type { UsageInfo } from "@koi/core/cost-tracker";
import { sessionId } from "@koi/core/ecs";
import type { KoiError } from "@koi/core/errors";
import type { ModelRequest } from "@koi/core/middleware";
import {
  createMockModelStreamHandler,
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyModelStreamHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createPayMiddleware } from "./pay.js";
import { createDefaultCostCalculator, createInMemoryPayLedger } from "./tracker.js";

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
      ledger: createInMemoryPayLedger(budget),
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
    const ledger = createInMemoryPayLedger(10);
    const mw = createPayMiddleware({
      ledger,
      calculator: createDefaultCostCalculator(),
      budget: 10,
    });
    const spy = createSpyModelHandler({
      content: "hello",
      model: "test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBeLessThan(10);
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
    const ledger = createInMemoryPayLedger(10);
    // Exhaust the budget
    await ledger.meter("10", "model_call");
    const mw = createPayMiddleware({
      ledger,
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
    const ledger = createInMemoryPayLedger(10);
    await ledger.meter("10", "model_call");
    const mw = createPayMiddleware({
      ledger,
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
    const ledger = createInMemoryPayLedger(10);
    await ledger.meter("10", "model_call");
    const mw = createPayMiddleware({
      ledger,
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
      ledger: createInMemoryPayLedger(0),
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
    const alerts: Array<{ readonly pct: number; readonly rem: number }> = [];
    const mw = createPayMiddleware({
      ledger: createInMemoryPayLedger(1.0),
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
    const ledger = createInMemoryPayLedger(10);
    await ledger.meter("10", "model_call");
    const mw = createPayMiddleware({
      ledger,
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
    const usages: Array<{ readonly totalSpent: number; readonly remaining: number }> = [];
    const mw = createPayMiddleware({
      ledger: createInMemoryPayLedger(10),
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
      ledger: createInMemoryPayLedger(10),
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
    const ledger = createInMemoryPayLedger(10);
    const mw = createPayMiddleware({
      ledger,
      calculator: createDefaultCostCalculator(),
      budget: 10,
    });
    const noUsageHandler = async (): Promise<import("@koi/core/middleware").ModelResponse> => ({
      content: "hi",
      model: "test",
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, noUsageHandler);
    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBe(10);
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
      const ledger = createInMemoryPayLedger(10);
      const mw = createPayMiddleware({
        ledger,
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
      const balance = await ledger.getBalance();
      // 100 * 0.01 + 50 * 0.02 = 1.00 + 1.00 = 2.00
      expect(10 - parseFloat(balance.available)).toBeCloseTo(2.0);
    });

    test("budget exhausted blocks stream before LLM call", async () => {
      const ledger = createInMemoryPayLedger(1);
      await ledger.meter("100", "model_call");
      const mw = createPayMiddleware({
        ledger,
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
        ledger: createInMemoryPayLedger(0),
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
      const ledger = createInMemoryPayLedger(1);
      await ledger.meter("100", "model_call");
      const mw = createPayMiddleware({
        ledger,
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
      const ledger = createInMemoryPayLedger(10);
      const mw = createPayMiddleware({
        ledger,
        calculator: createDefaultCostCalculator(),
        budget: 10,
      });
      const handler = createMockModelStreamHandler([
        { kind: "done", response: { content: "ok", model: "test-model" } }, // no usage
      ]);

      await drainStream(streamOf(mw)(ctx, { messages: [] }, handler));
      const balance = await ledger.getBalance();
      expect(parseFloat(balance.available)).toBe(10);
    });

    test("threshold alert fires after stream completes", async () => {
      const alerts: number[] = [];
      const mw = createPayMiddleware({
        ledger: createInMemoryPayLedger(1),
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

    test("updates after model call", async () => {
      const tracker = createInMemoryBudgetTracker();
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.01, output: 0.01 },
        }),
        budget: 10,
      });
      const spy = createSpyModelHandler({
        content: "hi",
        model: "test-model",
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      const result = mw.describeCapabilities?.(ctx);
      // Should show less than 10 remaining after spending
      expect(result?.description).not.toContain("10.0000 of $10.0000");
    });
  });

  describe("onUsage with breakdown", () => {
    test("onUsage includes breakdown after model call", async () => {
      const tracker = createInMemoryBudgetTracker();
      const usages: UsageInfo[] = [];
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.01, output: 0.01 },
        }),
        budget: 10,
        onUsage: (info) => {
          usages.push(info);
        },
      });
      const spy = createSpyModelHandler({
        content: "hi",
        model: "test-model",
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect(usages).toHaveLength(1);
      expect(usages[0]?.breakdown).toBeDefined();
      expect(usages[0]?.breakdown.totalCostUsd).toBeGreaterThan(0);
      expect(usages[0]?.breakdown.byModel).toHaveLength(1);
      expect(usages[0]?.breakdown.byModel[0]?.model).toBe("test-model");
    });

    test("onUsage includes breakdown after model stream", async () => {
      const tracker = createInMemoryBudgetTracker();
      const usages: UsageInfo[] = [];
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.01, output: 0.02 },
        }),
        budget: 10,
        onUsage: (info) => {
          usages.push(info);
        },
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
      const stream = mw.wrapModelStream;
      if (!stream) throw new Error("wrapModelStream not defined");
      for await (const _ of stream(ctx, { messages: [] }, handler)) {
        /* drain */
      }
      expect(usages).toHaveLength(1);
      expect(usages[0]?.breakdown.totalCostUsd).toBeGreaterThan(0);
    });
  });

  describe("per-session alert thresholds", () => {
    test("session A and B each fire own threshold alerts", async () => {
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

      // Session A: spend > 50%
      const ctxA = createMockTurnContext({ session: { sessionId: sessionId("session-A") } });
      const spy = createSpyModelHandler({
        content: "hi",
        model: "test-model",
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      await mw.wrapModelCall?.(ctxA, { messages: [] }, spy.handler);
      expect(alerts).toHaveLength(1);

      // Session B: spend > 50% — should also fire (separate session)
      const ctxB = createMockTurnContext({ session: { sessionId: sessionId("session-B") } });
      await mw.wrapModelCall?.(ctxB, { messages: [] }, spy.handler);
      expect(alerts).toHaveLength(2);
    });

    test("same threshold does not fire twice in one session", async () => {
      const tracker = createInMemoryBudgetTracker();
      const alerts: number[] = [];
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.001, output: 0.001 },
        }),
        budget: 1.0,
        alertThresholds: [0.5],
        onAlert: (pct) => {
          alerts.push(pct);
        },
      });
      const spy = createSpyModelHandler({
        content: "hi",
        model: "test-model",
        usage: { inputTokens: 400, outputTokens: 200 },
      });
      // First call: ~60% used
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect(alerts).toHaveLength(1);

      // Second call: still in same session, threshold already fired
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect(alerts).toHaveLength(1); // should NOT fire again
    });

    test("multiple thresholds fire in order within a session", async () => {
      const tracker = createInMemoryBudgetTracker();
      const firedThresholds: number[] = [];
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.01, output: 0.01 },
        }),
        budget: 1.0,
        alertThresholds: [0.5, 0.9],
        onAlert: (pct) => {
          firedThresholds.push(pct);
        },
      });
      // Spend 150% of budget: fires both thresholds
      const spy = createSpyModelHandler({
        content: "hi",
        model: "test-model",
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect(firedThresholds.length).toBeGreaterThanOrEqual(2);
    });

    test("session thresholds cleaned up on session end", async () => {
      const tracker = createInMemoryBudgetTracker();
      const alerts: number[] = [];
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator({
          "test-model": { input: 0.001, output: 0.001 },
        }),
        budget: 10.0,
        alertThresholds: [0.5],
        onAlert: (pct) => {
          alerts.push(pct);
        },
      });
      const spy = createSpyModelHandler({
        content: "hi",
        model: "test-model",
        usage: { inputTokens: 4000, outputTokens: 2000 },
      });
      // First call: 6000 * 0.001 = $6.00 = 60% of $10 => fires 50% threshold
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      const alertCountBefore = alerts.length;
      expect(alertCountBefore).toBeGreaterThanOrEqual(1);

      // End session — clears fired thresholds for this session
      const sessionCtx = createMockSessionContext();
      await mw.onSessionEnd?.(sessionCtx);

      // Second call: accumulates more cost, threshold re-fires since state was cleaned up
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect(alerts.length).toBeGreaterThan(alertCountBefore);
    });
  });

  describe("onBeforeTurn", () => {
    test("refreshes describeCapabilities", async () => {
      const tracker = createInMemoryBudgetTracker();
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator(),
        budget: 10,
      });

      // Pre-record some spend
      await tracker.record("session-test-1", {
        inputTokens: 100,
        outputTokens: 50,
        model: "test",
        costUsd: 5,
        timestamp: Date.now(),
      });

      // Before onBeforeTurn, capabilities show full budget
      const before = mw.describeCapabilities?.(ctx);
      expect(before?.description).toContain("10.0000");

      // After onBeforeTurn, capabilities should reflect remaining
      await mw.onBeforeTurn?.(ctx);
      const after = mw.describeCapabilities?.(ctx);
      expect(after?.description).toContain("5.0000");
    });

    test("with exhausted budget does not throw", async () => {
      const tracker = createInMemoryBudgetTracker();
      const mw = createPayMiddleware({
        tracker,
        calculator: createDefaultCostCalculator(),
        budget: 10,
      });
      await tracker.record("session-test-1", {
        inputTokens: 0,
        outputTokens: 0,
        model: "test",
        costUsd: 15,
        timestamp: Date.now(),
      });
      // onBeforeTurn should not throw even when budget is exhausted
      await expect(mw.onBeforeTurn?.(ctx)).resolves.toBeUndefined();
    });
  });
});

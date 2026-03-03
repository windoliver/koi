import { describe, expect, mock, test } from "bun:test";
import { sessionId } from "@koi/core/ecs";
import type { ToolHandler, ToolRequest, ToolResponse, TurnContext } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createInMemoryCallLimitStore } from "./store.js";
import { createToolCallLimitMiddleware } from "./tool-call-limit.js";
import type { LimitReachedInfo } from "./types.js";

function createTurnCtx(sid: string): TurnContext {
  const session = createMockSessionContext({ sessionId: sessionId(sid) });
  return createMockTurnContext({ session });
}

function toolReq(toolId: string): ToolRequest {
  return { toolId, input: {} };
}

/** Extract wrapToolCall with runtime assertion so TS narrows away undefined. */
function getWrapToolCall(
  mw: ReturnType<typeof createToolCallLimitMiddleware>,
): (ctx: TurnContext, request: ToolRequest, next: ToolHandler) => Promise<ToolResponse> {
  const wrap = mw.wrapToolCall;
  if (!wrap) throw new Error("wrapToolCall is not defined");
  return wrap;
}

describe("createToolCallLimitMiddleware", () => {
  test("has correct name and priority", () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 5 });
    expect(mw.name).toBe("koi:tool-call-limit");
    expect(mw.priority).toBe(175);
  });

  test("allows calls within global limit", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 3 });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    await wrap(ctx, toolReq("search"), spy.handler);
    await wrap(ctx, toolReq("search"), spy.handler);
    await wrap(ctx, toolReq("read"), spy.handler);

    expect(spy.calls.length).toBe(3);
  });

  test("blocks call exceeding global limit with 'continue' (default)", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 2 });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    await wrap(ctx, toolReq("search"), spy.handler);
    await wrap(ctx, toolReq("search"), spy.handler);

    const result = await wrap(ctx, toolReq("search"), spy.handler);
    expect(result.output).toContain("Tool call blocked");
    expect(result.metadata).toEqual({ blocked: true, reason: "tool_call_limit_exceeded" });
    expect(spy.calls.length).toBe(2);
  });

  test("globalLimit=0 blocks immediately", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 0 });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    const result = await wrap(ctx, toolReq("search"), spy.handler);
    expect(result.output).toContain("Tool call blocked");
    expect(spy.calls.length).toBe(0);
  });

  test("per-tool limit blocks only the limited tool", async () => {
    const mw = createToolCallLimitMiddleware({ limits: { search: 1 } });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    // search: 1 call OK
    await wrap(ctx, toolReq("search"), spy.handler);
    // search: blocked
    const blocked = await wrap(ctx, toolReq("search"), spy.handler);
    expect(blocked.output).toContain("Tool call blocked");

    // read: unlimited (no per-tool limit set)
    await wrap(ctx, toolReq("read"), spy.handler);
    await wrap(ctx, toolReq("read"), spy.handler);

    expect(spy.calls.length).toBe(3);
  });

  test("tool without per-tool limit is unlimited even with limits on others", async () => {
    const mw = createToolCallLimitMiddleware({ limits: { search: 1 } });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    // read has no limit set — should never be blocked by per-tool limits
    for (const _i of Array.from({ length: 10 })) {
      await wrap(ctx, toolReq("read"), spy.handler);
    }
    expect(spy.calls.length).toBe(10);
  });

  test("global limit fires first when both global and per-tool exceeded", async () => {
    const callback = mock(() => {});
    const mw = createToolCallLimitMiddleware({
      limits: { search: 5 },
      globalLimit: 2,
      onLimitReached: callback,
    });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    await wrap(ctx, toolReq("search"), spy.handler);
    await wrap(ctx, toolReq("search"), spy.handler);

    // Third call: global limit (2) fires before per-tool limit (5)
    const blocked = await wrap(ctx, toolReq("search"), spy.handler);
    expect(blocked.output).toContain("Tool call blocked");

    // Only the global limit callback should have fired (per-tool was not reached)
    expect(callback).toHaveBeenCalledTimes(1);
    const args = callback.mock.calls[0] as unknown as readonly [LimitReachedInfo];
    expect(args[0].limit).toBe(2); // global limit, not per-tool
  });

  test("exitBehavior 'error' throws KoiRuntimeError", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 0, exitBehavior: "error" });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    try {
      await wrap(ctx, toolReq("search"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("RATE_LIMIT");
      expect(err.retryable).toBe(false);
    }
  });

  test("exitBehavior 'end' throws KoiRuntimeError", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 0, exitBehavior: "end" });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    await expect(wrap(ctx, toolReq("search"), spy.handler)).rejects.toThrow(KoiRuntimeError);
  });

  test("onLimitReached fires exactly once per unique session+tool pair", async () => {
    const callback = mock(() => {});
    const mw = createToolCallLimitMiddleware({
      limits: { search: 1 },
      onLimitReached: callback,
    });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    await wrap(ctx, toolReq("search"), spy.handler);

    // Multiple blocked calls — callback should fire only once
    await wrap(ctx, toolReq("search"), spy.handler);
    await wrap(ctx, toolReq("search"), spy.handler);
    await wrap(ctx, toolReq("search"), spy.handler);

    expect(callback).toHaveBeenCalledTimes(1);
    const args2 = callback.mock.calls[0] as unknown as readonly [LimitReachedInfo];
    expect(args2[0].kind).toBe("tool");
    expect(args2[0].toolId).toBe("search");
  });

  test("different sessions have independent counters", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 1 });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx1 = createTurnCtx("s1");
    const ctx2 = createTurnCtx("s2");

    await wrap(ctx1, toolReq("search"), spy.handler);
    await wrap(ctx2, toolReq("search"), spy.handler);

    // Both sessions used their 1 call
    const blocked1 = await wrap(ctx1, toolReq("search"), spy.handler);
    const blocked2 = await wrap(ctx2, toolReq("search"), spy.handler);
    expect(blocked1.output).toContain("blocked");
    expect(blocked2.output).toContain("blocked");
    expect(spy.calls.length).toBe(2);
  });

  test("custom store with pre-filled counts works correctly", async () => {
    const store = createInMemoryCallLimitStore();
    // Pre-fill: 2 global calls already used
    store.increment("tool:s1:__global__");
    store.increment("tool:s1:__global__");

    const mw = createToolCallLimitMiddleware({ globalLimit: 3, store });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    // 3rd call OK
    await wrap(ctx, toolReq("search"), spy.handler);
    // 4th call blocked
    const blocked = await wrap(ctx, toolReq("search"), spy.handler);
    expect(blocked.output).toContain("blocked");
    expect(spy.calls.length).toBe(1);
  });

  test("per-tool limit of 0 blocks immediately", async () => {
    const mw = createToolCallLimitMiddleware({ limits: { search: 0 } });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    const blocked = await wrap(ctx, toolReq("search"), spy.handler);
    expect(blocked.output).toContain("blocked");
    expect(spy.calls.length).toBe(0);
  });

  test("error context includes toolId, limit, count, and exitBehavior", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 0, exitBehavior: "error" });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    try {
      await wrap(ctx, toolReq("search"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      const err = e as KoiRuntimeError;
      expect(err.context).toEqual({
        toolId: "search",
        limit: 0,
        count: 1,
        exitBehavior: "error",
      });
    }
  });

  test("blocked per-tool call does not consume global quota", async () => {
    // Regression: ensure global counter is not incremented when per-tool limit blocks
    const store = createInMemoryCallLimitStore();
    const mw = createToolCallLimitMiddleware({
      limits: { search: 1 },
      globalLimit: 100,
      store,
    });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    // First search call: passes both limits
    await wrap(ctx, toolReq("search"), spy.handler);

    // Second search call: blocked by per-tool limit
    const blocked = await wrap(ctx, toolReq("search"), spy.handler);
    expect(blocked.output).toContain("blocked");

    // Global counter should be 1, not 2
    const globalCount = await store.get("tool:s1:__global__");
    expect(globalCount).toBe(1);

    expect(spy.calls.length).toBe(1);
  });

  test("onLimitReached fires separately for different tools", async () => {
    const callback = mock(() => {});
    const mw = createToolCallLimitMiddleware({
      limits: { search: 1, read: 1 },
      onLimitReached: callback,
    });
    const wrap = getWrapToolCall(mw);
    const spy = createSpyToolHandler();
    const ctx = createTurnCtx("s1");

    // Exhaust both tools
    await wrap(ctx, toolReq("search"), spy.handler);
    await wrap(ctx, toolReq("search"), spy.handler); // blocked
    await wrap(ctx, toolReq("read"), spy.handler);
    await wrap(ctx, toolReq("read"), spy.handler); // blocked

    expect(callback).toHaveBeenCalledTimes(2);
    const calls = callback.mock.calls as unknown as ReadonlyArray<readonly [LimitReachedInfo]>;
    const tools = calls.map((c) => c[0].toolId);
    expect(tools).toContain("search");
    expect(tools).toContain("read");
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createToolCallLimitMiddleware({ globalLimit: 5 });
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'rate-limits' and description containing 'per-tool' when no globalLimit", () => {
      const mw = createToolCallLimitMiddleware({ limits: { search: 3 } });
      const ctx = createTurnCtx("s1");
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("rate-limits");
      expect(result?.description).toContain("per-tool");
    });
  });
});

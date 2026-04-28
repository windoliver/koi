import { describe, expect, mock, test } from "bun:test";
import type { ToolHandler, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createToolCallLimitMiddleware } from "./tool-call-limit.js";
import type { LimitReachedInfo } from "./types.js";

function turnCtx(sid = "s-1"): TurnContext {
  const rid = runId(`r-${sid}`);
  return {
    session: { agentId: "a", sessionId: sessionId(sid), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function okHandler(): ToolHandler {
  return async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });
}

describe("createToolCallLimitMiddleware", () => {
  test("allows calls below per-tool limit", async () => {
    const mw = createToolCallLimitMiddleware({ limits: { foo: 2 } });
    const ctx = turnCtx();
    const r1 = await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    const r2 = await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    expect(r1?.output).toBe("ok");
    expect(r2?.output).toBe("ok");
  });

  test("blocks at per-tool limit with continue (default)", async () => {
    const mw = createToolCallLimitMiddleware({ limits: { foo: 1 } });
    const ctx = turnCtx();
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    const blocked = await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    expect(blocked?.metadata?.blocked).toBe(true);
    expect(blocked?.metadata?.reason).toBe("tool_call_limit_exceeded");
  });

  test("throws RATE_LIMIT at per-tool limit with error exit", async () => {
    const mw = createToolCallLimitMiddleware({ limits: { foo: 1 }, exitBehavior: "error" });
    const ctx = turnCtx();
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    try {
      await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
      throw new Error("expected throw");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).code).toBe("RATE_LIMIT");
    }
  });

  test("global limit caps total tool calls across all tools", async () => {
    const mw = createToolCallLimitMiddleware({ globalLimit: 2 });
    const ctx = turnCtx();
    await mw.wrapToolCall?.(ctx, { toolId: "a", input: {} }, okHandler());
    await mw.wrapToolCall?.(ctx, { toolId: "b", input: {} }, okHandler());
    const blocked = await mw.wrapToolCall?.(ctx, { toolId: "c", input: {} }, okHandler());
    expect(blocked?.metadata?.blocked).toBe(true);
  });

  test("blocked per-tool call rolls back global counter", async () => {
    const mw = createToolCallLimitMiddleware({
      limits: { foo: 1 },
      globalLimit: 5,
    });
    const ctx = turnCtx();
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    // foo at limit; blocked. Global should NOT have been consumed for the blocked attempt.
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    // We should still be able to do 4 more global calls on other tools
    for (let i = 0; i < 4; i++) {
      const r = await mw.wrapToolCall?.(ctx, { toolId: `t${String(i)}`, input: {} }, okHandler());
      expect(r?.output).toBe("ok");
    }
    const blockedGlobal = await mw.wrapToolCall?.(ctx, { toolId: "tx", input: {} }, okHandler());
    expect(blockedGlobal?.metadata?.blocked).toBe(true);
  });

  test("counters are independent across sessions", async () => {
    const mw = createToolCallLimitMiddleware({ limits: { foo: 1 } });
    await mw.wrapToolCall?.(turnCtx("a"), { toolId: "foo", input: {} }, okHandler());
    const otherSession = await mw.wrapToolCall?.(
      turnCtx("b"),
      { toolId: "foo", input: {} },
      okHandler(),
    );
    expect(otherSession?.output).toBe("ok");
  });

  test("onLimitReached fires once per (session,tool) pair", async () => {
    const cb = mock((_info: LimitReachedInfo) => {});
    const mw = createToolCallLimitMiddleware({
      limits: { foo: 1 },
      onLimitReached: cb,
    });
    const ctx = turnCtx();
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    expect(cb).toHaveBeenCalledTimes(1);
    const arg = cb.mock.calls[0]?.[0];
    expect(arg?.kind).toBe("tool");
    if (arg?.kind === "tool") {
      expect(arg.toolId).toBe("foo");
      expect(arg.limit).toBe(1);
    }
  });

  test("does not throw when onLimitReached itself throws", async () => {
    const mw = createToolCallLimitMiddleware({
      limits: { foo: 1 },
      onLimitReached: () => {
        throw new Error("observer fail");
      },
    });
    const ctx = turnCtx();
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    const r = await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    expect(r?.metadata?.blocked).toBe(true);
  });

  test("describeCapabilities mentions cap source", () => {
    const ctx = turnCtx();
    const a = createToolCallLimitMiddleware({ globalLimit: 10 });
    const b = createToolCallLimitMiddleware({ limits: { foo: 5 } });
    expect(a.describeCapabilities(ctx)?.description).toContain("10");
    expect(b.describeCapabilities(ctx)?.description).toContain("per-tool");
  });

  // Regression: per-session state must be released on session end so a
  // long-lived runtime does not accumulate counters for dead sessions.
  test("onSessionEnd resets per-session counters and fired markers", async () => {
    const mw = createToolCallLimitMiddleware({
      limits: { foo: 1 },
      globalLimit: 5,
      onLimitReached: () => {},
    });
    const ctx = turnCtx("s-cleanup");
    await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    // foo at limit; second call blocks.
    const blocked = await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    expect(blocked?.metadata?.blocked).toBe(true);

    // End session.
    await mw.onSessionEnd?.(ctx.session);

    // After cleanup, the same sessionId should see fresh counters — first
    // post-cleanup call must succeed (not be blocked).
    const fresh = await mw.wrapToolCall?.(ctx, { toolId: "foo", input: {} }, okHandler());
    expect(fresh?.output).toBe("ok");
  });
});

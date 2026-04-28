import { describe, expect, mock, test } from "bun:test";
import type { ToolHandler, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createCallDedupMiddleware } from "./call-dedup.js";

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

function makeHandler(out: unknown): { handler: ToolHandler; calls: number } {
  let calls = 0;
  const handler: ToolHandler = async (_req: ToolRequest): Promise<ToolResponse> => {
    calls++;
    return { output: out };
  };
  return {
    handler,
    get calls(): number {
      return calls;
    },
  };
}

describe("createCallDedupMiddleware", () => {
  test("returns cached response on identical second call", async () => {
    const mw = createCallDedupMiddleware();
    const ctx = turnCtx();
    const h = makeHandler("first");
    const r1 = await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "x" } }, h.handler);
    const r2 = await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "x" } }, h.handler);
    expect(r1?.output).toBe("first");
    expect(r2?.output).toBe("first");
    expect(r2?.metadata?.cached).toBe(true);
    expect(h.calls).toBe(1);
  });

  test("different sessions do not share cache", async () => {
    const mw = createCallDedupMiddleware();
    const h = makeHandler("ok");
    await mw.wrapToolCall?.(turnCtx("a"), { toolId: "t", input: {} }, h.handler);
    await mw.wrapToolCall?.(turnCtx("b"), { toolId: "t", input: {} }, h.handler);
    expect(h.calls).toBe(2);
  });

  test("different inputs miss cache", async () => {
    const mw = createCallDedupMiddleware();
    const ctx = turnCtx();
    const h = makeHandler("ok");
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: { q: "a" } }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: { q: "b" } }, h.handler);
    expect(h.calls).toBe(2);
  });

  test("expired entries trigger re-execution", async () => {
    let now = 1000;
    const mw = createCallDedupMiddleware({ ttlMs: 100, now: () => now });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, h.handler);
    now += 200;
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, h.handler);
    expect(h.calls).toBe(2);
  });

  test("default exclude bypasses cache for shell_exec", async () => {
    const mw = createCallDedupMiddleware();
    const ctx = turnCtx();
    const h = makeHandler("ran");
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: { cmd: "ls" } }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: { cmd: "ls" } }, h.handler);
    expect(h.calls).toBe(2);
  });

  test("user exclude is merged with defaults", async () => {
    const mw = createCallDedupMiddleware({ exclude: ["custom_writer"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "custom_writer", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "custom_writer", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, h.handler);
    expect(h.calls).toBe(3);
  });

  test("include whitelist limits caching", async () => {
    const mw = createCallDedupMiddleware({ include: ["allowed"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "allowed", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "allowed", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "other", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "other", input: {} }, h.handler);
    expect(h.calls).toBe(3);
  });

  test("blocked response is not cached", async () => {
    const mw = createCallDedupMiddleware();
    const ctx = turnCtx();
    let calls = 0;
    const handler: ToolHandler = async () => {
      calls++;
      return { output: "blocked", metadata: { blocked: true } };
    };
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, handler);
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, handler);
    expect(calls).toBe(2);
  });

  test("error response is not cached", async () => {
    const mw = createCallDedupMiddleware();
    const ctx = turnCtx();
    let calls = 0;
    const handler: ToolHandler = async () => {
      calls++;
      return { output: "boom", metadata: { error: true } };
    };
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, handler);
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, handler);
    expect(calls).toBe(2);
  });

  test("onCacheHit fires on hit and swallows errors", async () => {
    const cb = mock(() => {
      throw new Error("observer fail");
    });
    const mw = createCallDedupMiddleware({ onCacheHit: cb });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, h.handler);
    const r = await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, h.handler);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(r?.metadata?.cached).toBe(true);
  });

  test("describeCapabilities describes the cache", () => {
    const mw = createCallDedupMiddleware();
    expect(mw.describeCapabilities(turnCtx())?.label).toBe("call-dedup");
  });
});

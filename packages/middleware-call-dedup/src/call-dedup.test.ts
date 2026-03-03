import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core/ecs";
import type { ToolRequest, ToolResponse } from "@koi/core/middleware";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createCallDedupMiddleware } from "./call-dedup.js";
import { DEFAULT_EXCLUDE } from "./config.js";
import type { CacheHitInfo } from "./types.js";

function toolRequest(toolId: string, input: Record<string, unknown> = {}): ToolRequest {
  return { toolId, input };
}

describe("createCallDedupMiddleware", () => {
  test("has correct name and priority", () => {
    const mw = createCallDedupMiddleware();
    expect(mw.name).toBe("koi:call-dedup");
    expect(mw.priority).toBe(185);
  });

  test("cache hit: 2nd identical call skips execution", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "result1" });
    const req = toolRequest("file_read", { path: "/a.txt" });

    const r1 = await wrap(ctx, req, spy.handler);
    const r2 = await wrap(ctx, req, spy.handler);

    expect(spy.calls.length).toBe(1);
    expect(r1.output).toBe("result1");
    expect(r2.output).toBe("result1");
    expect(r2.metadata?.cached).toBe(true);
  });

  test("cache miss: different toolId executes separately", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });

    await wrap(ctx, toolRequest("tool_a"), spy.handler);
    await wrap(ctx, toolRequest("tool_b"), spy.handler);

    expect(spy.calls.length).toBe(2);
  });

  test("cache miss: different input executes separately", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });

    await wrap(ctx, toolRequest("file_read", { path: "/a" }), spy.handler);
    await wrap(ctx, toolRequest("file_read", { path: "/b" }), spy.handler);

    expect(spy.calls.length).toBe(2);
  });

  test("TTL expiry: stale entry re-executes", async () => {
    let clock = 1000;
    const mw = createCallDedupMiddleware({ ttlMs: 100, now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "fresh" });
    const req = toolRequest("file_read", { path: "/a" });

    await wrap(ctx, req, spy.handler);
    // Advance past TTL
    clock = 1200;
    await wrap(ctx, req, spy.handler);

    expect(spy.calls.length).toBe(2);
  });

  test("excluded tool always executes", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({
      now: () => clock,
      exclude: ["my_mutation"],
    });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });
    const req = toolRequest("my_mutation", { data: "x" });

    await wrap(ctx, req, spy.handler);
    await wrap(ctx, req, spy.handler);

    expect(spy.calls.length).toBe(2);
  });

  test("DEFAULT_EXCLUDE tools are excluded by default", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });

    for (const toolId of DEFAULT_EXCLUDE) {
      await wrap(ctx, toolRequest(toolId), spy.handler);
      await wrap(ctx, toolRequest(toolId), spy.handler);
    }

    // Each DEFAULT_EXCLUDE tool called twice = 2 * DEFAULT_EXCLUDE.length
    expect(spy.calls.length).toBe(DEFAULT_EXCLUDE.length * 2);
  });

  test("user exclude merges with DEFAULT_EXCLUDE", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({
      now: () => clock,
      exclude: ["custom_write"],
    });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });

    // shell_exec from DEFAULT_EXCLUDE
    await wrap(ctx, toolRequest("shell_exec"), spy.handler);
    await wrap(ctx, toolRequest("shell_exec"), spy.handler);
    // custom_write from user exclude
    await wrap(ctx, toolRequest("custom_write"), spy.handler);
    await wrap(ctx, toolRequest("custom_write"), spy.handler);

    expect(spy.calls.length).toBe(4);
  });

  test("include list restricts caching scope", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({
      now: () => clock,
      include: ["file_read"],
    });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });

    // file_read is included → cached
    await wrap(ctx, toolRequest("file_read"), spy.handler);
    await wrap(ctx, toolRequest("file_read"), spy.handler);
    expect(spy.calls.length).toBe(1);

    // web_search is NOT included → always executes
    await wrap(ctx, toolRequest("web_search"), spy.handler);
    await wrap(ctx, toolRequest("web_search"), spy.handler);
    expect(spy.calls.length).toBe(3);
  });

  test("include + exclude: tool in both is excluded", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({
      now: () => clock,
      include: ["shell_exec", "file_read"],
      exclude: [],
    });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });

    // shell_exec is in DEFAULT_EXCLUDE → excluded even though in include list
    await wrap(ctx, toolRequest("shell_exec"), spy.handler);
    await wrap(ctx, toolRequest("shell_exec"), spy.handler);
    expect(spy.calls.length).toBe(2);

    // file_read is included and not excluded → cached
    await wrap(ctx, toolRequest("file_read"), spy.handler);
    await wrap(ctx, toolRequest("file_read"), spy.handler);
    expect(spy.calls.length).toBe(3);
  });

  test("tool exception is not cached", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    let callCount = 0;
    const failHandler = async (_req: ToolRequest): Promise<ToolResponse> => {
      callCount++;
      throw new Error("tool failed");
    };
    const req = toolRequest("search", { q: "test" });

    await expect(wrap(ctx, req, failHandler)).rejects.toThrow("tool failed");
    await expect(wrap(ctx, req, failHandler)).rejects.toThrow("tool failed");

    expect(callCount).toBe(2);
  });

  test("blocked response is not cached", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({
      output: "blocked",
      metadata: { blocked: true, reason: "denied" },
    });
    const req = toolRequest("file_read", { path: "/secret" });

    await wrap(ctx, req, spy.handler);
    await wrap(ctx, req, spy.handler);

    // Blocked responses are not cached → both calls execute
    expect(spy.calls.length).toBe(2);
  });

  test("cached response has metadata.cached = true", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "data" });
    const req = toolRequest("file_read", { path: "/a" });

    const r1 = await wrap(ctx, req, spy.handler);
    const r2 = await wrap(ctx, req, spy.handler);

    expect(r1.metadata?.cached).toBeUndefined();
    expect(r2.metadata?.cached).toBe(true);
  });

  test("onCacheHit callback fires with correct info", async () => {
    const clock = 1000;
    const hits: CacheHitInfo[] = [];
    const mw = createCallDedupMiddleware({
      now: () => clock,
      onCacheHit: (info) => hits.push(info),
    });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler({ output: "ok" });
    const req = toolRequest("file_read", { path: "/a" });

    await wrap(ctx, req, spy.handler);
    expect(hits.length).toBe(0);

    await wrap(ctx, req, spy.handler);
    expect(hits.length).toBe(1);
    const hit = hits[0];
    expect(hit).toBeDefined();
    if (hit) {
      expect(hit.toolId).toBe("file_read");
      expect(hit.sessionId).toBe(ctx.session.sessionId);
      expect(typeof hit.cacheKey).toBe("string");
    }
  });

  test("session isolation: different sessionId = separate cache entries", async () => {
    const clock = 1000;
    const mw = createCallDedupMiddleware({ now: () => clock });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall is not defined");
    const ctxA = createMockTurnContext({
      session: createMockSessionContext({ sessionId: sessionId("sess-a") }),
    });
    const ctxB = createMockTurnContext({
      session: createMockSessionContext({ sessionId: sessionId("sess-b") }),
    });
    const spy = createSpyToolHandler({ output: "ok" });
    const req = toolRequest("file_read", { path: "/a" });

    await wrap(ctxA, req, spy.handler);
    await wrap(ctxB, req, spy.handler);

    // Different sessions → both execute
    expect(spy.calls.length).toBe(2);
  });

  test("describeCapabilities returns capability fragment", () => {
    const mw = createCallDedupMiddleware();
    const ctx = createMockTurnContext();
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeDefined();
    if (cap) {
      expect(cap.label).toBe("call-dedup");
      expect(typeof cap.description).toBe("string");
    }
  });
});

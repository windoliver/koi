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
  // Default behavior is opt-in passthrough: nothing is cached without an
  // explicit allowlist. Callers that want caching MUST list deterministic
  // tools in `include`.
  test("without include allowlist: passthrough — nothing is cached", async () => {
    const mw = createCallDedupMiddleware();
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "x" } }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "x" } }, h.handler);
    expect(h.calls).toBe(2);
  });

  // Stateful reads (task_list, notebook_read, etc.) and side-effecting
  // writes (task_create, koi_send_message, etc.) MUST not be cached by
  // default. The opt-in design enforces this without a giant denylist.
  test("without include: stateful read tools are NOT cached", async () => {
    const mw = createCallDedupMiddleware();
    const ctx = turnCtx();
    const h = makeHandler("v");
    for (const toolId of ["task_list", "notebook_read", "task_update", "koi_send_message"]) {
      await mw.wrapToolCall?.(ctx, { toolId, input: {} }, h.handler);
      await mw.wrapToolCall?.(ctx, { toolId, input: {} }, h.handler);
    }
    expect(h.calls).toBe(8); // 4 tools × 2 calls each
  });

  test("returns cached response on identical second call (with include)", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
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
    const mw = createCallDedupMiddleware({ include: ["t"] });
    const h = makeHandler("ok");
    await mw.wrapToolCall?.(turnCtx("a"), { toolId: "t", input: {} }, h.handler);
    await mw.wrapToolCall?.(turnCtx("b"), { toolId: "t", input: {} }, h.handler);
    expect(h.calls).toBe(2);
  });

  test("different inputs miss cache", async () => {
    const mw = createCallDedupMiddleware({ include: ["t"] });
    const ctx = turnCtx();
    const h = makeHandler("ok");
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: { q: "a" } }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: { q: "b" } }, h.handler);
    expect(h.calls).toBe(2);
  });

  test("expired entries trigger re-execution", async () => {
    let now = 1000;
    const mw = createCallDedupMiddleware({ ttlMs: 100, now: () => now, include: ["t"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, h.handler);
    now += 200;
    await mw.wrapToolCall?.(ctx, { toolId: "t", input: {} }, h.handler);
    expect(h.calls).toBe(2);
  });

  // DEFAULT_EXCLUDE is a hard floor: even if a caller mistakenly includes
  // a mutating tool like shell_exec in `include`, it is still bypassed.
  test("DEFAULT_EXCLUDE wins over user include for mutating tools", async () => {
    const mw = createCallDedupMiddleware({ include: ["shell_exec", "lookup"] });
    const ctx = turnCtx();
    const h = makeHandler("ran");
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: { cmd: "ls" } }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: { cmd: "ls" } }, h.handler);
    // lookup IS cacheable
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, h.handler);
    expect(h.calls).toBe(3); // 2 + 1
  });

  test("user exclude is merged with defaults", async () => {
    const mw = createCallDedupMiddleware({
      include: ["custom_writer"],
      exclude: ["custom_writer"],
    });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "custom_writer", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "custom_writer", input: {} }, h.handler);
    expect(h.calls).toBe(2);
  });

  test("blocked response is not cached", async () => {
    const mw = createCallDedupMiddleware({ include: ["t"] });
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
    const mw = createCallDedupMiddleware({ include: ["t"] });
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
    const mw = createCallDedupMiddleware({ onCacheHit: cb, include: ["t"] });
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

  // Regression: two concurrent identical misses must coalesce onto a single
  // underlying execution, otherwise dedup fails the retry-storm scenario it
  // exists to mitigate.
  test("concurrent identical misses execute next() exactly once", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    let executions = 0;
    let resolveOnce: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveOnce = r;
    });
    const handler: ToolHandler = async () => {
      executions++;
      await gate;
      return { output: "v" };
    };

    const p1 = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, handler);
    const p2 = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, handler);
    // Both promises issued before any result is stored.
    resolveOnce?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(executions).toBe(1);
    expect(r1?.output).toBe("v");
    expect(r2?.output).toBe("v");
  });
});

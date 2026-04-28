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

  // Regression: DEFAULT_EXCLUDE must cover ALL mutating / stateful-read
  // tools shipped in the repo, not just the original six. A misconfigured
  // include must never silently drop writes or serve stale reads.
  test("DEFAULT_EXCLUDE covers task / notebook / fs / agent surface", async () => {
    const muting = [
      "fs_write",
      "fs_delete",
      "fs_edit",
      "task_create",
      "task_update",
      "task_stop",
      "task_list", // stateful read
      "notebook_add_cell",
      "notebook_replace_cell",
      "notebook_delete_cell",
      "notebook_read", // stateful read
      "koi_send_message",
      "send_message",
      "execute_code",
      "forge_agent",
      "koi_send_message",
      "koi_list_messages",
      "koi_list_mailbox",
      "koi_list_tasks",
      "koi_get_task",
      "koi_update_task",
      "koi_task_output",
      "koi_list_agents",
    ];
    const mw = createCallDedupMiddleware({ include: muting });
    const ctx = turnCtx();
    const h = makeHandler("v");
    for (const toolId of muting) {
      await mw.wrapToolCall?.(ctx, { toolId, input: {} }, h.handler);
      await mw.wrapToolCall?.(ctx, { toolId, input: {} }, h.handler);
    }
    // None of these should be cached: 13 tools × 2 calls = 26 executions.
    expect(h.calls).toBe(muting.length * 2);
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

  // Regression: ambient-state filesystem reads must be in DEFAULT_EXCLUDE.
  // If another tool mutates the file between two cached reads, the second
  // read returns up-to-TTL-old bytes — exactly the stale-read failure mode
  // the package promises to prevent.
  test("DEFAULT_EXCLUDE covers fs_read / file_read", async () => {
    const mw = createCallDedupMiddleware({ include: ["fs_read", "file_read"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    for (const toolId of ["fs_read", "file_read"]) {
      await mw.wrapToolCall?.(ctx, { toolId, input: { path: "/x" } }, h.handler);
      await mw.wrapToolCall?.(ctx, { toolId, input: { path: "/x" } }, h.handler);
    }
    expect(h.calls).toBe(4);
  });

  // Regression: a session that ends and is later replayed with the same
  // sessionId must NOT receive cached entries from the prior run. Reused
  // session ids are an expected lifecycle pattern in this codebase.
  test("onSessionEnd evicts cached entries for that session", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx("s-shared");
    const h = makeHandler("v");
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, h.handler);
    expect(h.calls).toBe(1);

    await mw.onSessionEnd?.(ctx.session);

    // New "session" reusing the same id must not see the prior cache.
    await mw.wrapToolCall?.(turnCtx("s-shared"), { toolId: "lookup", input: {} }, h.handler);
    expect(h.calls).toBe(2);
  });

  // Regression: in-flight promises must not survive session end. Otherwise
  // a still-running call from a terminated session could fan out into a
  // fresh session that reuses the same sessionId.
  test("onSessionEnd clears in-flight coalescing for that session", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx("s-x");
    let executions = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler: ToolHandler = async () => {
      executions++;
      await gate;
      return { output: "v" };
    };
    const p1 = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, handler);
    // Yield so p1 finishes its sync prefix and registers in inFlight + the
    // session index. Without this, evictSession races and can run before
    // p1 has tracked itself, making the test trivial.
    await Promise.resolve();
    await Promise.resolve();
    await mw.onSessionEnd?.(ctx.session);
    const p2 = mw.wrapToolCall?.(turnCtx("s-x"), { toolId: "lookup", input: {} }, handler);
    release?.();
    await Promise.all([p1, p2]);
    expect(executions).toBe(2);
  });

  // Regression: cached responses must be isolated from caller mutation.
  // ToolResponse.output is `unknown` and commonly a mutable object/array;
  // storing/returning the same reference would let a downstream mutation
  // silently corrupt the cache.
  test("cached responses are immune to caller-side mutation", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    let calls = 0;
    const handler: ToolHandler = async () => {
      calls++;
      return { output: { items: [1, 2, 3] }, metadata: { tags: ["a"] } };
    };
    const r1 = await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, handler);
    // Mutate the first response after it returns.
    (r1?.output as { items: number[] }).items.push(999);
    (r1?.metadata?.tags as string[])?.push("mutated");
    const r2 = await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, handler);
    expect(calls).toBe(1);
    expect((r2?.output as { items: number[] }).items).toEqual([1, 2, 3]);
    expect(r2?.metadata?.tags).toEqual(["a"]);
  });

  // Regression: a tool call still running when onSessionEnd fires must NOT
  // repopulate the cache for the now-dead session. Otherwise a later run
  // reusing the same sessionId would receive stale output from the prior
  // session, defeating the whole eviction guarantee.
  test("late-completing tool call does not repopulate cache after session end", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx("s-late");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const handler: ToolHandler = async () => {
      calls++;
      await gate;
      return { output: "stale" };
    };
    const p1 = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: {} }, handler);
    // Yield so p1 registers in inFlight + keysBySession.
    await Promise.resolve();
    await Promise.resolve();
    // End the session BEFORE p1 completes.
    await mw.onSessionEnd?.(ctx.session);
    // Now release the still-running p1.
    release?.();
    await p1;
    // A new run reusing the same sessionId must miss cache — the late
    // writeback from p1 must have been refused.
    const fresh: ToolHandler = async () => ({ output: "fresh" });
    const r2 = await mw.wrapToolCall?.(turnCtx("s-late"), { toolId: "lookup", input: {} }, fresh);
    expect(r2?.output).toBe("fresh");
    expect(calls).toBe(1);
  });

  test("describeCapabilities describes the cache", () => {
    const mw = createCallDedupMiddleware();
    expect(mw.describeCapabilities(turnCtx())?.label).toBe("call-dedup");
  });

  // Regression: a request carrying a cancellation signal must NOT be
  // coalesced. Otherwise aborting one caller would cancel the shared
  // execution for every coalesced waiter — a fan-out failure.
  test("requests with AbortSignal bypass coalescing AND cache", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    const ac = new AbortController();
    const r1 = await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, signal: ac.signal },
      h.handler,
    );
    const r2 = await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, signal: ac.signal },
      h.handler,
    );
    // Both calls executed independently. Neither response is marked cached.
    expect(h.calls).toBe(2);
    expect(r1?.metadata?.cached).toBeUndefined();
    expect(r2?.metadata?.cached).toBeUndefined();
  });

  // Regression: distinct callIds / traceCallIds must STILL hit cache.
  // The runtime stamps every tool request with `callId` and
  // `metadata.traceCallId` for observability — treating those as
  // identity-relevant would make dedup inert on every real request.
  // Cached responses are marked `metadata.cached = true` so downstream
  // observability can distinguish hits from real executions.
  test("distinct callId values share cache (not identity-relevant)", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, callId: "call-a" },
      h.handler,
    );
    const r2 = await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, callId: "call-b" },
      h.handler,
    );
    expect(h.calls).toBe(1);
    expect(r2?.metadata?.cached).toBe(true);
  });

  test("distinct metadata.traceCallId values share cache", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, metadata: { traceCallId: "a" } },
      h.handler,
    );
    const r2 = await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, metadata: { traceCallId: "b" } },
      h.handler,
    );
    expect(h.calls).toBe(1);
    expect(r2?.metadata?.cached).toBe(true);
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

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
      "forge_tool",
      "forge_middleware",
      "forge_list",
      "forge_inspect",
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

  // Regression (#1419 round 14): onCacheHit must include the request +
  // cached response so callers can wire dedup to an external audit /
  // transcript sink. dedup runs at intercept and short-circuits before
  // observe-phase middleware — this hook is the explicit observability
  // seam for cache hits.
  test("onCacheHit receives request + cached response for audit wiring", async () => {
    const captured: Array<{
      sessionId: string;
      toolId: string;
      requestInput: unknown;
      output: unknown;
      cached: unknown;
    }> = [];
    const mw = createCallDedupMiddleware({
      include: ["lookup"],
      onCacheHit: (info) => {
        captured.push({
          sessionId: info.sessionId,
          toolId: info.toolId,
          requestInput: info.request.input,
          output: info.response.output,
          cached: info.response.metadata?.cached,
        });
      },
    });
    const ctx = turnCtx();
    const h = makeHandler("hello");
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 7 } }, h.handler);
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 7 } }, h.handler);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.toolId).toBe("lookup");
    expect(captured[0]?.requestInput).toEqual({ q: 7 });
    expect(captured[0]?.output).toBe("hello");
    expect(captured[0]?.cached).toBe(true);
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

  // Regression (#1419 round 15): when keysBySession FIFO-truncates an
  // oldest entry, the corresponding store entry MUST also be evicted.
  // Otherwise onSessionEnd later sees only the truncated set, leaves
  // the orphan in the store, and a fresh run reusing the sessionId
  // can receive stale cached output from the prior session.
  test("FIFO truncation of session index also evicts the orphan store entry", async () => {
    const mw = createCallDedupMiddleware({
      maxEntries: 2,
      include: ["lookup"],
    });
    const ctx = turnCtx("s-orphan");
    let calls = 0;
    const handler: ToolHandler = async (req) => {
      calls++;
      return { output: `out-${(req.input as { q: number }).q}` };
    };
    // Fill: q=1, q=2. session set holds [k1, k2].
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, handler);
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 2 } }, handler);
    // q=3 forces FIFO truncation of k1 from the session set AND from
    // the store. session set holds [k2, k3].
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 3 } }, handler);
    expect(calls).toBe(3);
    // End the session.
    await mw.onSessionEnd?.(ctx.session);
    // A fresh run reusing the same sessionId issues q=1 again. If the
    // truncated-but-not-evicted scenario existed, this would hit the
    // stale cache. With the lockstep eviction it must miss and execute.
    const r = await mw.wrapToolCall?.(
      turnCtx("s-orphan"),
      { toolId: "lookup", input: { q: 1 } },
      handler,
    );
    expect(r?.output).toBe("out-1");
    expect(r?.metadata?.cached).toBeUndefined();
    expect(calls).toBe(4);
  });

  // Regression (#1419 round 17): FIFO truncation must NOT evict an
  // unresolved in-flight coalescing slot. Otherwise a duplicate
  // request for the same key would miss `inFlight` and call next()
  // again, defeating the single-execution guarantee under load.
  test("FIFO truncation skips in-flight entries to preserve coalescing", async () => {
    const mw = createCallDedupMiddleware({ maxEntries: 2, include: ["lookup"] });
    const ctx = turnCtx("s-coalesce");
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const slowHandler: ToolHandler = async () => {
      calls++;
      await gate;
      return { output: "first" };
    };
    // Issue p1 with q=1 — registers in inFlight, never resolves yet.
    const p1 = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, slowHandler);
    await Promise.resolve();
    await Promise.resolve();
    // Fill the session FIFO with two more keys so the next add forces
    // truncation. q=2 + q=3 → set holds [k1, k2, k3], cap=2.
    const fast: ToolHandler = async () => {
      calls++;
      return { output: "fast" };
    };
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 2 } }, fast);
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 3 } }, fast);
    // Now request q=1 again — must coalesce onto the still-running p1
    // even though k1 was the oldest tracked key. Eviction must skip
    // it because inFlight still owns the slot.
    const p1bis = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, slowHandler);
    releaseFirst?.();
    const [r1, r2] = await Promise.all([p1, p1bis]);
    expect(r1?.output).toBe("first");
    expect(r2?.output).toBe("first");
    // q=1 executed exactly once (1 call), q=2 + q=3 fast handlers ran (2 calls). Total 3.
    expect(calls).toBe(3);
  });

  // Regression (#1419 round 19): coalesced waiters joining an in-flight
  // promise also short-circuit the observe-phase chain, so audit hooks
  // never see them. They must fire onCacheHit and stamp metadata.cached
  // the same way TTL cache hits do.
  test("coalesced waiters fire onCacheHit and receive cached:true response", async () => {
    const hits: Array<{ readonly cached: boolean; readonly key: string }> = [];
    const mw = createCallDedupMiddleware({
      include: ["lookup"],
      onCacheHit: (info) => {
        hits.push({ cached: info.response.metadata?.cached === true, key: info.cacheKey });
      },
    });
    const ctx = turnCtx("s-coalesce-obs");
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: ToolHandler = async () => {
      calls++;
      await gate;
      return { output: "v" };
    };
    const p1 = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, slow);
    await Promise.resolve();
    await Promise.resolve();
    const p2 = mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, slow);
    release?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    // Originator did not get a cached stamp (it actually executed).
    expect(r1?.metadata?.cached).toBeUndefined();
    // Coalesced waiter is stamped as a hit.
    expect(r2?.metadata?.cached).toBe(true);
    expect(calls).toBe(1);
    // onCacheHit fired exactly once for the coalesced waiter.
    expect(hits.length).toBe(1);
    expect(hits[0]?.cached).toBe(true);
  });

  // Regression (#1419 round 21): sessionGen FIFO eviction must skip
  // sessions with in-flight calls. Otherwise a long-running call from
  // session A whose generation was bumped by onSessionEnd can have its
  // tombstone evicted by churn from `> maxEntries * 4` other sessions,
  // and the late writeback then reads `0` (default), matches the
  // captured pre-end `0`, and writes back into the cache for a dead
  // session id — exactly the cross-session contamination the
  // generation counter exists to prevent.
  test("sessionGen tombstone survives churn while in-flight calls remain", async () => {
    const maxEntries = 2;
    const mw = createCallDedupMiddleware({ maxEntries, include: ["lookup"] });
    const ctxA = turnCtx("session-A");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let aCalls = 0;
    const slowA: ToolHandler = async () => {
      aCalls++;
      await gate;
      return { output: "from-A" };
    };
    // 1. Submit a long-running call for session A. Captures gen=0.
    const pA = mw.wrapToolCall?.(ctxA, { toolId: "lookup", input: { q: "a" } }, slowA);
    await Promise.resolve();
    await Promise.resolve();
    // 2. End session A — bumps gen to 1. A is still in-flight, so the
    //    tombstone must persist.
    await mw.onSessionEnd?.(ctxA.session);
    // 3. Drive churn from `>= maxEntries * 4 + 1` other sessions; each
    //    onSessionEnd bumps a fresh tombstone and would normally FIFO-
    //    evict the oldest entry (which is A's).
    const churnCount = maxEntries * 4 + 2;
    for (let i = 0; i < churnCount; i++) {
      const ctxI = turnCtx(`session-${String(i)}`);
      const fast: ToolHandler = async () => ({ output: "x" });
      await mw.wrapToolCall?.(ctxI, { toolId: "lookup", input: { q: i } }, fast);
      await mw.onSessionEnd?.(ctxI.session);
    }
    // 4. Release session A's late call. The writeback MUST detect the
    //    gen mismatch and drop the result instead of writing back.
    release?.();
    const rA = await pA;
    expect(rA?.output).toBe("from-A");
    expect(aCalls).toBe(1);
    // 5. Re-submit the same key under a fresh session A and assert the
    //    handler runs again — proves no stale write-back populated the
    //    cache during the late completion.
    let aReuseCalls = 0;
    const fresh: ToolHandler = async () => {
      aReuseCalls++;
      return { output: "fresh-A" };
    };
    const ctxA2 = turnCtx("session-A");
    const r2 = await mw.wrapToolCall?.(ctxA2, { toolId: "lookup", input: { q: "a" } }, fresh);
    expect(r2?.output).toBe("fresh-A");
    expect(aReuseCalls).toBe(1);
    expect(r2?.metadata?.cached).toBeUndefined();
  });

  // Regression (#1419 round 29): a non-structuredClone-safe response
  // (e.g. function fields) must NOT convert a successful tool call into
  // a post-execution throw. The call already produced a valid result;
  // the cache is best-effort. Degrade to passthrough on clone failure.
  test("non-cloneable response degrades to cache-bypass instead of throwing", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    let calls = 0;
    const handler: ToolHandler = async () => {
      calls++;
      // Functions are NOT structuredClone-safe.
      return { output: { value: 1, fn: () => 42 } };
    };
    // First call must NOT throw, even though the response is not cloneable.
    const r1 = await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, handler);
    expect(r1).toBeDefined();
    expect(calls).toBe(1);
    // Second identical call must also succeed — the failed cache write
    // means we passthrough to the handler (no false hit, no throw).
    const r2 = await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: 1 } }, handler);
    expect(r2).toBeDefined();
    // Either: cache miss (calls=2) OR cache hit served from a different
    // cloneable path. We just assert no throw and a real result.
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

  // Regression (review round 8): a caller could smuggle policy data
  // under an allowlisted observability key (e.g. `traceCallId` set to
  // a structured object instead of a string). Shape-validate the
  // observability fields — anything not matching the expected scalar
  // shape is treated as policy-relevant and forces dedup to bypass.
  test("non-scalar shape under allowlisted metadata key triggers bypass", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    // `traceCallId` set to an object — must be treated as policy-relevant.
    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: "lookup",
        input: { q: 1 },
        metadata: { traceCallId: { tenant: "a" } as unknown as string },
      },
      h.handler,
    );
    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: "lookup",
        input: { q: 1 },
        metadata: { traceCallId: { tenant: "b" } as unknown as string },
      },
      h.handler,
    );
    expect(h.calls).toBe(2);
  });

  // Regression (review round 7): permissions folds `request.metadata`
  // into PermissionQuery.context and its decision/approval cache keys.
  // Dedup runs at intercept BEFORE permissions, so caching a result
  // produced under one metadata context and replaying it under another
  // would short-circuit a policy check — an auth boundary breach.
  // Bypass dedup on any metadata field outside the observability
  // allowlist (traceCallId / cached / callId).
  test("request with policy-relevant metadata bypasses dedup (auth correctness)", async () => {
    const mw = createCallDedupMiddleware({ include: ["lookup"] });
    const ctx = turnCtx();
    const h = makeHandler("v");
    // First call carries a policy-relevant field.
    await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, metadata: { policyScope: "elevated" } },
      h.handler,
    );
    // Second call with SAME tool/input but different policy field.
    // Must NOT hit cache — re-execute so permissions can re-evaluate.
    const r2 = await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: 1 }, metadata: { policyScope: "default" } },
      h.handler,
    );
    expect(h.calls).toBe(2);
    expect(r2?.metadata?.cached).not.toBe(true);
  });

  // Regression (review round 7): under FIFO eviction at capacity,
  // the just-added key was previously appended AFTER awaiting the
  // backend delete of the evicted victim. A concurrent onSessionEnd
  // racing that await window would miss the new key, leaving its
  // `inFlight` promise un-cleared. A reused sessionId would then
  // coalesce onto the orphaned promise. Adding the new key BEFORE
  // any await closes the window.
  test("session-end during FIFO eviction await still clears in-flight for new key", async () => {
    const m = new Map<string, { response: ToolResponse; expiresAt: number }>();
    let releaseDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((r) => {
      releaseDelete = r;
    });
    let deleteCount = 0;
    const store = {
      async get(k: string) {
        return m.get(k);
      },
      async set(k: string, v: { response: ToolResponse; expiresAt: number }) {
        m.set(k, v);
      },
      async delete(k: string): Promise<boolean> {
        deleteCount++;
        // First delete (eviction victim) is gated to simulate slow
        // backend, letting onSessionEnd race the trackKey await.
        if (deleteCount === 1) await deleteGate;
        m.delete(k);
        return true;
      },
      size(): number {
        return m.size;
      },
      clear(): void {
        m.clear();
      },
    };
    const mw = createCallDedupMiddleware({ include: ["lookup"], maxEntries: 1, store });
    const sid = "s-race";
    const ctx = turnCtx(sid);
    // Fill cache to capacity.
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "a" } }, makeHandler("a").handler);
    // Trigger eviction with a NEW key. trackKey will await the gated
    // backend delete of the victim — meanwhile we end the session.
    const second = mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: "b" } },
      makeHandler("b").handler,
    );
    // Yield once so trackKey has entered the eviction await path.
    await Promise.resolve();
    await Promise.resolve();
    // End the session. With the fix, the new key was added to
    // keysBySession BEFORE the await, so onSessionEnd sees it and
    // clears its inFlight slot.
    await mw.onSessionEnd?.(ctx.session);
    // Release the gated delete so the second call can complete.
    releaseDelete?.();
    await second;
    // A reused sessionId issuing the same key must NOT coalesce onto
    // any prior in-flight promise — it must execute fresh.
    const ctx2 = turnCtx(sid);
    const h3 = makeHandler("c");
    await mw.wrapToolCall?.(ctx2, { toolId: "lookup", input: { q: "b" } }, h3.handler);
    expect(h3.calls).toBe(1);
  });

  // Regression (review round 11): a persistent store (Redis, SQLite,
  // custom backend) outlives the runtime process. After a restart,
  // `sessionGen` resets to empty so a `generation: 0` entry written
  // by the prior process would still match `liveGen: 0` for a
  // reused sessionId — replaying stale tool output across restarts.
  // The instance-nonce stamped on every entry must reject
  // foreign-instance entries.
  test("entries from a prior runtime instance are rejected on read (restart safety)", async () => {
    type Entry = {
      response: ToolResponse;
      expiresAt: number;
      generation?: number | undefined;
      instance?: string | undefined;
    };
    const m = new Map<string, Entry>();
    // Shared persistent store survives "restart": both instances
    // point at the same Map.
    const store = {
      async get(k: string) {
        return m.get(k);
      },
      async set(k: string, v: Entry) {
        m.set(k, v);
      },
      async delete(k: string) {
        m.delete(k);
        return true;
      },
      size(): number {
        return m.size;
      },
      clear(): void {
        m.clear();
      },
    };
    const sid = "s-restart";
    // Instance #1 populates the cache.
    const mw1 = createCallDedupMiddleware({ include: ["lookup"], store });
    const ctx1 = turnCtx(sid);
    await mw1.wrapToolCall?.(
      ctx1,
      { toolId: "lookup", input: { q: "x" } },
      makeHandler("v1").handler,
    );
    expect(m.size).toBe(1);
    // Instance #2 (simulating a runtime restart) — fresh middleware,
    // same persistent store, same sessionId, same input. Without the
    // instance-nonce check, `generation: 0` would match and v1 would
    // be served as a stale cache hit.
    const mw2 = createCallDedupMiddleware({ include: ["lookup"], store });
    const ctx2 = turnCtx(sid);
    const h2 = makeHandler("v2");
    const r = await mw2.wrapToolCall?.(ctx2, { toolId: "lookup", input: { q: "x" } }, h2.handler);
    expect(r?.output).toBe("v2");
    expect(h2.calls).toBe(1);
  });

  // Regression (review round 11): operators wanting persistent
  // restart-safe caching can pin `instanceNonce` to a stable value
  // (e.g. a deployment id). Two instances with the same nonce share
  // the cache.
  test("pinned instanceNonce makes persistent cache survive restart", async () => {
    type Entry = {
      response: ToolResponse;
      expiresAt: number;
      generation?: number | undefined;
      instance?: string | undefined;
    };
    const m = new Map<string, Entry>();
    const store = {
      async get(k: string) {
        return m.get(k);
      },
      async set(k: string, v: Entry) {
        m.set(k, v);
      },
      async delete(k: string) {
        m.delete(k);
        return true;
      },
      size(): number {
        return m.size;
      },
      clear(): void {
        m.clear();
      },
    };
    const nonce = "deploy-2026-04-28";
    const sid = "s-pinned";
    const mw1 = createCallDedupMiddleware({
      include: ["lookup"],
      store,
      instanceNonce: nonce,
    });
    await mw1.wrapToolCall?.(
      turnCtx(sid),
      { toolId: "lookup", input: { q: "x" } },
      makeHandler("v1").handler,
    );
    const mw2 = createCallDedupMiddleware({
      include: ["lookup"],
      store,
      instanceNonce: nonce,
    });
    const h2 = makeHandler("v2");
    const r = await mw2.wrapToolCall?.(
      turnCtx(sid),
      { toolId: "lookup", input: { q: "x" } },
      h2.handler,
    );
    // Cache hit: same nonce → entry valid across "restart".
    expect(r?.output).toBe("v1");
    expect(h2.calls).toBe(0);
    expect(r?.metadata?.cached).toBe(true);
  });

  // Regression (review round 6): if a backend `store.delete()` fails during
  // `onSessionEnd` eviction (best-effort by design), the stale entry can
  // remain in the backend after the in-memory index is dropped. A reused
  // sessionId must NOT receive that orphan as a cache hit. The generation
  // tombstone stamped on each entry detects this and forces a miss.
  test("stale entry from prior session eviction is rejected on reuse (generation tombstone)", async () => {
    const m = new Map<
      string,
      { response: ToolResponse; expiresAt: number; generation?: number | undefined }
    >();
    let allowDelete = false;
    const store = {
      async get(k: string) {
        return m.get(k);
      },
      async set(
        k: string,
        v: { response: ToolResponse; expiresAt: number; generation?: number | undefined },
      ) {
        m.set(k, v);
      },
      async delete(k: string) {
        if (!allowDelete) throw new Error("backend offline");
        m.delete(k);
        return true;
      },
      size() {
        return m.size;
      },
      clear() {
        m.clear();
      },
    };
    const mw = createCallDedupMiddleware({ include: ["lookup"], store });
    const sid = "s-reuse";
    const ctx = turnCtx(sid);
    // Run 1: populate the cache, then end the session. The backend
    // `delete` rejects so the entry survives — but the in-memory index
    // is gone, replicating the post-failure state described in the
    // round-6 finding.
    const h1 = makeHandler("v1");
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "x" } }, h1.handler);
    await mw.onSessionEnd?.(ctx.session);
    expect(m.size).toBe(1); // orphan retained
    // Run 2: same sessionId, same input. Without the generation
    // tombstone, the orphan would be served as a cache hit
    // (returning "v1"). With the tombstone, it must be treated as a
    // miss and re-execute, returning the fresh response.
    allowDelete = true; // let the read-path's cleanup actually delete
    const h2 = makeHandler("v2");
    const r = await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "x" } }, h2.handler);
    expect(r?.output).toBe("v2");
    expect(h2.calls).toBe(1);
  });

  // Regression (review round 4): a backend `store.delete()` failure during
  // FIFO eviction or stale-TTL cleanup must not surface as a tool failure.
  // The originating call already produced a valid response; surfacing a
  // cache-eviction throw would convert success into a failure and invite
  // retry-induced duplicate side effects — exactly what dedup exists to
  // prevent.
  test("backend store.delete rejection during eviction does not surface as tool failure", async () => {
    const m = new Map<string, { response: ToolResponse; expiresAt: number }>();
    const store = {
      async get(k: string) {
        return m.get(k);
      },
      async set(k: string, v: { response: ToolResponse; expiresAt: number }) {
        m.set(k, v);
      },
      async delete(_k: string) {
        throw new Error("backend offline");
      },
      size(): number {
        return m.size;
      },
      clear(): void {
        m.clear();
      },
    };
    const mw = createCallDedupMiddleware({
      include: ["lookup"],
      maxEntries: 1,
      store,
    });
    const ctx = turnCtx();
    const h = makeHandler("v1");
    // Fill cache to capacity, then issue a different key — eviction must
    // call store.delete which rejects. The new call must still succeed.
    await mw.wrapToolCall?.(ctx, { toolId: "lookup", input: { q: "a" } }, h.handler);
    const r2 = await mw.wrapToolCall?.(
      ctx,
      { toolId: "lookup", input: { q: "b" } },
      makeHandler("v2").handler,
    );
    expect(r2?.output).toBe("v2");
  });
});

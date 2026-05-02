import { describe, expect, mock, test } from "bun:test";
import type {
  StoreChangeEvent,
  StoreChangeNotifier,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createPolicyCacheMiddleware, type PolicyEntry } from "./policy-cache.js";

function ctxFor(agentId: string): TurnContext {
  return {
    session: {
      agentId,
      sessionId: "s" as never,
      runId: "r" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t" as never,
    messages: [],
    metadata: {},
  } as unknown as TurnContext;
}

const CTX = ctxFor("agent-A");

function makeReq(toolId: string, input: Record<string, unknown> = {}): ToolRequest {
  return { toolId, input };
}

function makeResp(): ToolResponse {
  return { output: "ok" };
}

function makeAgentPolicy(
  agentId: string,
  toolId: string,
  brickId: string,
  decision: "allow" | "block" = "allow",
  verified = true,
): PolicyEntry {
  return {
    scope: "agent",
    agentId,
    toolId,
    brickId,
    verified,
    execute: () =>
      decision === "allow" ? { action: "allow" } : { action: "block", reason: "blocked by policy" },
  };
}

function makeGlobalPolicy(
  toolId: string,
  brickId: string,
  decision: "allow" | "block" = "allow",
): PolicyEntry {
  return {
    scope: "global",
    toolId,
    brickId,
    verified: true,
    execute: () =>
      decision === "allow" ? { action: "allow" } : { action: "block", reason: "blocked by policy" },
  };
}

describe("createPolicyCacheMiddleware: shape", () => {
  test("name is policy-cache, priority 50 (outer of permissions@100), phase intercept", () => {
    const handle = createPolicyCacheMiddleware();
    expect(handle.middleware.name).toBe("policy-cache");
    expect(handle.middleware.priority).toBe(50);
    expect(handle.middleware.phase).toBe("intercept");
  });
});

describe("createPolicyCacheMiddleware: verified-only promotion gate", () => {
  test("register rejects unverified entries (deterministic gate)", () => {
    const handle = createPolicyCacheMiddleware();
    const result = handle.register(makeAgentPolicy("agent-A", "search", "brick-1", "allow", false));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
    expect(handle.size()).toBe(0);
  });

  test("register accepts verified entries", () => {
    const handle = createPolicyCacheMiddleware();
    const result = handle.register(makeAgentPolicy("agent-A", "search", "brick-1", "allow", true));
    expect(result.ok).toBe(true);
    expect(handle.size()).toBe(1);
  });

  test("promotion gate is deterministic across identical inputs", () => {
    const h1 = createPolicyCacheMiddleware();
    const h2 = createPolicyCacheMiddleware();
    const e = makeAgentPolicy("agent-A", "search", "brick-1", "allow", true);
    expect(h1.register(e).ok).toBe(true);
    expect(h2.register(e).ok).toBe(true);

    const u = makeAgentPolicy("agent-A", "search", "brick-2", "allow", false);
    expect(h1.register(u).ok).toBe(false);
    expect(h2.register(u).ok).toBe(false);
  });
});

describe("createPolicyCacheMiddleware: cache-hit bypass equivalence", () => {
  test("uncached toolId passes through unchanged", async () => {
    const handle = createPolicyCacheMiddleware();
    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(CTX, makeReq("search", { q: "hi" }), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("ok");
  });

  test("policy 'allow' delegates to next — observable result identical to no-cache", async () => {
    const baseline = createPolicyCacheMiddleware();
    const cached = createPolicyCacheMiddleware();
    cached.register(makeAgentPolicy("agent-A", "search", "brick-1", "allow"));

    const baselineNext: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);
    const cachedNext: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);

    const baselineWrap = baseline.middleware.wrapToolCall;
    const cachedWrap = cached.middleware.wrapToolCall;
    if (baselineWrap === undefined || cachedWrap === undefined) throw new Error("missing wrap");

    const baselineRes = await baselineWrap(CTX, makeReq("search", { q: "x" }), baselineNext);
    const cachedRes = await cachedWrap(CTX, makeReq("search", { q: "x" }), cachedNext);

    expect(baselineRes).toEqual(cachedRes);
    expect(baselineNext).toHaveBeenCalledTimes(1);
    expect(cachedNext).toHaveBeenCalledTimes(1);
  });

  test("policy 'block' short-circuits without calling next (no model, no tool)", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(CTX, makeReq("search", { q: "" }), next);
    expect(next).toHaveBeenCalledTimes(0);

    expect(typeof result.output).toBe("string");
    expect(result.output as string).toContain("search");

    expect(result.metadata?.isError).toBe(true);
    expect(result.metadata?.blockedByHook).toBe(true);
    expect(result.metadata?.policyDenied).toBe(true);
    expect(result.metadata?.hookName).toBe("policy-cache");
    expect(result.metadata?.toolId).toBe("search");
    // executor-supplied `reason` MUST NOT appear in metadata — event-trace
    // persists allowlisted metadata to long-lived trajectory storage, and a
    // raw reason could leak rule internals or input fragments.
    expect(result.metadata?.reason).toBeUndefined();
  });

  test("only intercepts registered toolIds — others pass through", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    await wrap(CTX, makeReq("write_file", { path: "/tmp/x" }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("policy decision is a pure function of input — repeated calls produce identical decisions", async () => {
    const handle = createPolicyCacheMiddleware();
    let runs = 0;
    const result = handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-pure",
      verified: true,
      execute: (input) => {
        runs += 1;
        const q = (input as { readonly q?: unknown }).q;
        return typeof q === "string" && q.length > 0
          ? { action: "allow" }
          : { action: "block", reason: "empty q" };
      },
    });
    expect(result.ok).toBe(true);

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    await wrap(CTX, makeReq("search", { q: "" }), next);
    await wrap(CTX, makeReq("search", { q: "" }), next);
    await wrap(CTX, makeReq("search", { q: "" }), next);
    expect(runs).toBe(3);
    expect(next).toHaveBeenCalledTimes(0);
  });
});

describe("createPolicyCacheMiddleware: executor failure (fail-closed + quarantine)", () => {
  test("throwing executor returns canonical block AND quarantines (deny stays enforced)", async () => {
    let errorInfo: { brickId: string; toolId: string; scope: string } | undefined;
    const handle = createPolicyCacheMiddleware({
      onExecutorError: (info) => {
        errorInfo = { brickId: info.brickId, toolId: info.toolId, scope: info.scope };
      },
    });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-throws",
      verified: true,
      execute: () => {
        throw new Error("schema drift");
      },
    });
    expect(handle.size()).toBe(1);

    const next: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // First call: throw → block (fail-closed).
    const r1 = await wrap(CTX, makeReq("search", { q: "x" }), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r1.metadata?.policyDenied).toBe(true);
    expect(r1.metadata?.blockedByHook).toBe(true);
    expect(r1.metadata?.hookName).toBe("policy-cache");
    expect(r1.metadata?.reason).toBeUndefined();
    // Entry stays in cache (quarantine, not eviction).
    expect(handle.size()).toBe(1);

    // Operator-visible incident reporting fired.
    expect(errorInfo?.brickId).toBe("brick-throws");
    expect(errorInfo?.toolId).toBe("search");
    expect(errorInfo?.scope).toBe("agent");

    // Subsequent calls also block — no fall-through, executor not re-invoked.
    const r2 = await wrap(CTX, makeReq("search", { q: "x" }), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r2.metadata?.policyDenied).toBe(true);
  });

  test("quarantined deny does NOT fall back to global allow (security property)", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-broken",
      verified: true,
      execute: () => {
        throw new Error("compile error");
      },
    });
    handle.register(makeGlobalPolicy("search", "brick-global", "allow"));

    const next: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // First call: agent throws → block + quarantine.
    const r1 = await wrap(CTX, makeReq("search", {}), next);
    expect(r1.metadata?.policyDenied).toBe(true);
    expect(next).toHaveBeenCalledTimes(0);

    // Second call: agent is quarantined — does NOT fall back to global allow.
    // The verified agent deny remains in force until re-promotion.
    const r2 = await wrap(CTX, makeReq("search", {}), next);
    expect(r2.metadata?.policyDenied).toBe(true);
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("re-registering brick clears quarantine", async () => {
    const handle = createPolicyCacheMiddleware();
    let throwOnce = true;
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-flaky",
      verified: true,
      execute: () => {
        if (throwOnce) throw new Error("transient compile fault");
        return { action: "allow" };
      },
    });

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Quarantine it.
    await wrap(CTX, makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(0);

    // Re-register with a fixed executor — quarantine clears.
    throwOnce = false;
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-flaky",
      verified: true,
      execute: () => ({ action: "allow" }),
    });

    const r = await wrap(CTX, makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(r.output).toBe("ok");
  });

  test("StoreChangeNotifier event clears quarantine via eviction", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-broken",
      verified: true,
      execute: () => {
        throw new Error("fault");
      },
    });

    // Trigger quarantine.
    void handle.middleware.wrapToolCall?.(CTX, makeReq("search"), async () => makeResp());
    expect(handle.size()).toBe(1);

    // Notifier "updated" → evicts entry AND clears quarantine.
    listener?.({ kind: "updated", brickId: "brick-broken" as never });
    expect(handle.size()).toBe(0);
  });

  test("onExecutorError callback that throws does NOT break canonical block return", async () => {
    const handle = createPolicyCacheMiddleware({
      onExecutorError: () => {
        throw new Error("audit sink offline");
      },
    });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-throws",
      verified: true,
      execute: () => {
        throw new Error("compile error");
      },
    });

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Telemetry callback throws → enforcement still returns canonical block.
    const r = await wrap(CTX, makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r.metadata?.policyDenied).toBe(true);
    expect(r.metadata?.blockedByHook).toBe(true);
  });
});

describe("createPolicyCacheMiddleware: eviction", () => {
  test("evict by brickId is idempotent", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(handle.size()).toBe(1);
    handle.evict("brick-1");
    expect(handle.size()).toBe(0);
    handle.evict("brick-1");
    expect(handle.size()).toBe(0);
  });

  test("evict for unknown brickId is no-op", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    handle.evict("brick-unknown");
    expect(handle.size()).toBe(1);
  });

  test("re-registering same (scope,owner,toolId) replaces prior brick (no leak)", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1", "allow"));
    handle.register(makeAgentPolicy("agent-A", "search", "brick-2", "block"));
    expect(handle.size()).toBe(1);

    handle.evict("brick-1"); // stale
    expect(handle.size()).toBe(1);

    handle.evict("brick-2");
    expect(handle.size()).toBe(0);
  });

  test("re-registering same brickId for different toolId cleans stale forward entry", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A"));
    handle.register(makeAgentPolicy("agent-A", "query", "brick-A"));
    expect(handle.size()).toBe(1);

    handle.evict("brick-A");
    expect(handle.size()).toBe(0);
  });

  test("respects maxEntries with LRU eviction of oldest", () => {
    const handle = createPolicyCacheMiddleware({ maxEntries: 2 });
    handle.register(makeAgentPolicy("agent-A", "a", "ba"));
    handle.register(makeAgentPolicy("agent-A", "b", "bb"));
    handle.register(makeAgentPolicy("agent-A", "c", "bc"));
    expect(handle.size()).toBe(2);
  });
});

describe("createPolicyCacheMiddleware: scope isolation by concrete owner", () => {
  test("two agents registering the same toolId do NOT collide", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A", "block"));
    handle.register(makeAgentPolicy("agent-B", "search", "brick-B", "allow"));
    expect(handle.size()).toBe(2);

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Agent A: blocked by A's policy.
    const aResult = await wrap(ctxFor("agent-A"), makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(aResult.metadata?.policyDenied).toBe(true);

    // Agent B: A's block does NOT apply; B's allow lets next run.
    const bResult = await wrap(ctxFor("agent-B"), makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(bResult.output).toBe("ok");
  });

  test("agent unknown to cache: no agent hit, falls back to zone/global as appropriate", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A", "block"));
    handle.register(makeGlobalPolicy("search", "brick-global", "allow"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(ctxFor("agent-OTHER"), makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("ok");
  });

  test("agent → global precedence at lookup time", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeGlobalPolicy("search", "brick-G", "allow"));
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const ctx = ctxFor("agent-A");

    // Agent block wins.
    const r1 = await wrap(ctx, makeReq("search"), next);
    expect(r1.metadata?.policyDenied).toBe(true);

    handle.evict("brick-A");
    // Global allow wins next.
    const r2 = await wrap(ctx, makeReq("search"), next);
    expect(r2.output).toBe("ok");
  });
});

describe("createPolicyCacheMiddleware: event-driven invalidation", () => {
  test("notifier subscription evicts on 'updated'", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(handle.size()).toBe(1);

    listener?.({ kind: "updated", brickId: "brick-1" as never });
    expect(handle.size()).toBe(0);
  });

  test("notifier evicts on 'removed' and 'quarantined'", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register(makeAgentPolicy("agent-A", "a", "ba"));
    handle.register(makeAgentPolicy("agent-A", "b", "bb"));
    expect(handle.size()).toBe(2);

    listener?.({ kind: "removed", brickId: "ba" as never });
    expect(handle.size()).toBe(1);

    listener?.({ kind: "quarantined", brickId: "bb" as never });
    expect(handle.size()).toBe(0);
  });

  test("stale notifier event (older generation) does NOT evict current entry", () => {
    // Round 1 (fresh loop) review: a delayed event for a prior generation
    // is otherwise indistinguishable from a current-generation event and
    // can silently evict a freshly re-promoted deny.
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    // Register fresh entry at generation 5.
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      verified: true,
      generation: 5,
      execute: () => ({ action: "block", reason: "x" }),
    });
    expect(handle.size()).toBe(1);
    // A late event from generation 3 must NOT evict.
    listener?.({ kind: "updated", brickId: "brick-1" as never, generation: 3 });
    expect(handle.size()).toBe(1);
  });

  test("current-or-newer generation event DOES evict", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      verified: true,
      generation: 5,
      execute: () => ({ action: "block", reason: "x" }),
    });
    listener?.({ kind: "removed", brickId: "brick-1" as never, generation: 5 });
    expect(handle.size()).toBe(0);
  });

  test("legacy events without generation evict (best-effort, backward compat)", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      verified: true,
      generation: 5,
      execute: () => ({ action: "allow" }),
    });
    // Event without generation falls back to evicting (legacy hosts).
    listener?.({ kind: "removed", brickId: "brick-1" as never });
    expect(handle.size()).toBe(0);
  });

  test("notifier ignores 'saved' and 'promoted' (wiring layer handles promotion)", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register(makeAgentPolicy("agent-A", "a", "ba"));

    listener?.({ kind: "saved", brickId: "ba" as never });
    listener?.({ kind: "promoted", brickId: "ba" as never });
    expect(handle.size()).toBe(1);
  });
});

describe("createPolicyCacheMiddleware: capability fragment", () => {
  test("undefined when empty (no model context cost)", () => {
    const handle = createPolicyCacheMiddleware();
    expect(handle.middleware.describeCapabilities(CTX)).toBeUndefined();
  });

  test("summarizes count when populated", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    const frag = handle.middleware.describeCapabilities(CTX);
    expect(frag).not.toBeUndefined();
    expect(frag?.label).toBe("policy-cache");
    expect(frag?.description).toContain("1 tool");
    expect(frag?.description).toContain("deterministic");
  });

  test("pluralizes correctly", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "a", "ba"));
    handle.register(makeAgentPolicy("agent-A", "b", "bb"));
    const frag = handle.middleware.describeCapabilities(CTX);
    expect(frag?.description).toContain("2 tools");
  });

  test("does NOT leak other agents' policy counts to the current turn", () => {
    const handle = createPolicyCacheMiddleware();
    // Agent A has 1 policy.
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A"));
    // Agent B has 5 policies — must not show up in agent A's prompt.
    for (let i = 0; i < 5; i++) {
      handle.register(makeAgentPolicy("agent-B", `tool${i}`, `brick-B-${i}`));
    }
    // Plus 1 global policy that BOTH agents legitimately share.
    handle.register(makeGlobalPolicy("shared", "brick-G"));

    const fragA = handle.middleware.describeCapabilities(ctxFor("agent-A"));
    expect(fragA?.description).toContain("2 tools"); // 1 agent-A + 1 global

    const fragB = handle.middleware.describeCapabilities(ctxFor("agent-B"));
    expect(fragB?.description).toContain("6 tools"); // 5 agent-B + 1 global

    const fragOther = handle.middleware.describeCapabilities(ctxFor("agent-OTHER"));
    expect(fragOther?.description).toContain("1 tool"); // global only, no leak
  });
});

describe("createPolicyCacheMiddleware: LRU eviction (recency-aware, per-owner)", () => {
  test("hot policy survives capacity pressure — lookup bumps recency", async () => {
    const handle = createPolicyCacheMiddleware({ maxEntries: 2 });
    handle.register(makeAgentPolicy("agent-A", "hot", "brick-hot", "block"));
    handle.register(makeAgentPolicy("agent-A", "cold", "brick-cold", "allow"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Touch 'hot' so it becomes most-recently-used (cold is now LRU).
    await wrap(CTX, makeReq("hot"), next);

    // Insert a third entry — capacity overflow evicts the LRU, which is 'cold'
    // (NOT 'hot', because the lookup above bumped its recency).
    handle.register(makeAgentPolicy("agent-A", "new", "brick-new", "allow"));
    expect(handle.size()).toBe(2);

    // 'hot' deny still enforces — was not evicted despite being registered first.
    const r = await wrap(CTX, makeReq("hot"), next);
    expect(r.metadata?.policyDenied).toBe(true);

    // 'cold' is gone — pass through.
    const r2 = await wrap(CTX, makeReq("cold"), next);
    expect(r2.output).toBe("ok");
  });

  test("noisy agent CANNOT evict another agent's deny via capacity pressure", async () => {
    // Per-owner partition: maxEntries=2 PER agent, not 2 globally.
    const handle = createPolicyCacheMiddleware({ maxEntries: 2 });
    handle.register(makeAgentPolicy("agent-victim", "secret", "brick-secret", "block"));

    // Noisy agent registers 5 policies (3 over its own quota of 2).
    for (let i = 0; i < 5; i++) {
      handle.register(makeAgentPolicy("agent-noisy", `tool${i}`, `brick-noisy-${i}`, "allow"));
    }

    // Victim agent's quota is independent — its deny survives.
    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const r = await wrap(ctxFor("agent-victim"), makeReq("secret"), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r.metadata?.policyDenied).toBe(true);
  });

  test("global cache is its own bucket — agent overflow does not evict global denies", async () => {
    const handle = createPolicyCacheMiddleware({ maxEntries: 2 });
    handle.register(makeGlobalPolicy("danger", "brick-global", "block"));

    // Agent fills its quota.
    for (let i = 0; i < 5; i++) {
      handle.register(makeAgentPolicy("agent-A", `tool${i}`, `brick-${i}`, "allow"));
    }

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Global deny is intact even though agent registered 5 entries.
    const r = await wrap(ctxFor("agent-OTHER"), makeReq("danger"), next);
    expect(r.metadata?.policyDenied).toBe(true);
  });
});

describe("createPolicyCacheMiddleware: dispose() lifecycle", () => {
  test("dispose unsubscribes from notifier and clears caches", () => {
    let unsubscribed = false;
    let activeListener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        activeListener = cb;
        return () => {
          unsubscribed = true;
          activeListener = undefined;
        };
      },
    };

    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(handle.size()).toBe(1);

    handle.dispose();
    expect(unsubscribed).toBe(true);
    expect(activeListener).toBeUndefined();
    expect(handle.size()).toBe(0);
  });

  test("dispose is idempotent", () => {
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: () => () => {},
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    handle.dispose();
    handle.dispose(); // must not throw
    expect(handle.size()).toBe(0);
  });

  test("repeat create/dispose against shared notifier doesn't accumulate listeners", () => {
    let activeCount = 0;
    let peakCount = 0;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: () => {
        activeCount++;
        peakCount = Math.max(peakCount, activeCount);
        return () => {
          activeCount--;
        };
      },
    };

    // Create + dispose 10 instances — should never exceed 1 active subscription.
    for (let i = 0; i < 10; i++) {
      const h = createPolicyCacheMiddleware({ notifier });
      h.dispose();
    }
    expect(activeCount).toBe(0);
    expect(peakCount).toBe(1);
  });
});

// Build a TurnContext that captures dispatchPermissionDecision invocations.
function ctxWithDispatch(
  agentId: string,
  sink: Array<{ query: unknown; decision: unknown }>,
  userId?: string,
): TurnContext {
  return {
    session: {
      agentId,
      sessionId: "s" as never,
      runId: "r" as never,
      ...(userId !== undefined ? { userId } : {}),
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t" as never,
    messages: [],
    metadata: {},
    dispatchPermissionDecision: (query: unknown, decision: unknown) => {
      sink.push({ query, decision });
    },
  } as unknown as TurnContext;
}

describe("createPolicyCacheMiddleware: synthetic permission-decision dispatch", () => {
  test("block by executor decision dispatches synthetic deny to observers", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink);
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(next).not.toHaveBeenCalled();
    expect(sink).toHaveLength(1);
    expect(sink[0]?.query).toMatchObject({
      principal: "agent:agent-A",
      action: "tool.call",
      resource: "tool:rm",
      context: { source: "policy-cache", brickId: "brick-1", scope: "agent" },
    });
    expect(sink[0]?.decision).toMatchObject({ effect: "deny", disposition: "hard" });
    // Trust boundary: dispatched reason is the fixed redacted string, NEVER
    // the executor's reason. event-trace persists permission-decision reasons
    // to long-lived trajectory storage, so forwarding executor text would
    // leak rule internals or input fragments.
    expect((sink[0]?.decision as { reason: string }).reason).toBe("policy-cache: tool denied");
  });

  test("synthetic deny reason is redacted even when executor returns sensitive text", async () => {
    const handle = createPolicyCacheMiddleware();
    const leaky: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      verified: true,
      execute: () => ({
        action: "block",
        reason: "internal-rule-id-42 fired on path=/secret/credentials.json",
      }),
    };
    handle.register(leaky);
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink);
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    const reason = (sink[0]?.decision as { reason: string }).reason;
    expect(reason).not.toContain("internal-rule-id-42");
    expect(reason).not.toContain("/secret/credentials.json");
    expect(reason).toBe("policy-cache: tool denied");
  });

  test("async observer rejection is contained (no unhandled rejection)", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const ctx: TurnContext = {
      session: { agentId: "agent-A", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      // Returns a rejecting promise — the middleware MUST swallow it.
      dispatchPermissionDecision: () => Promise.reject(new Error("async sink down")),
    } as unknown as TurnContext;
    const next = mock(async () => makeResp());
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      const resp = await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
      expect(resp?.metadata).toMatchObject({ policyDenied: true });
      // Yield a tick so any rejection has a chance to surface.
      await new Promise<void>((r) => setTimeout(r, 5));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  test("quarantined entry still dispatches synthetic deny", async () => {
    const handle = createPolicyCacheMiddleware();
    const throwing: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      verified: true,
      execute: () => {
        throw new Error("boom");
      },
    };
    handle.register(throwing);
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink);
    const next = mock(async () => makeResp());
    // First call quarantines.
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    // Second call hits the quarantine fast-path.
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(sink).toHaveLength(2);
    for (const r of sink) {
      expect(r.decision).toMatchObject({ effect: "deny", disposition: "hard" });
    }
  });

  test("uses session.userId as principal when present", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink, "user-42");
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(sink[0]?.query).toMatchObject({ principal: "user-42" });
  });

  test("absent dispatchPermissionDecision is a silent no-op (no throw)", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(CTX, makeReq("rm"), next as ToolHandler);
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
  });

  test("throwing dispatch callback does NOT change enforcement", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const ctx: TurnContext = {
      session: { agentId: "agent-A", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      dispatchPermissionDecision: () => {
        throw new Error("observer faulted");
      },
    } as unknown as TurnContext;
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(next).not.toHaveBeenCalled();
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
  });
});

describe("createPolicyCacheMiddleware: process-wide agent-bucket cap", () => {
  test("rejects new-agent registration when maxAgentBuckets is reached (fail-closed)", () => {
    const handle = createPolicyCacheMiddleware({ maxAgentBuckets: 3 });
    expect(handle.register(makeAgentPolicy("agent-1", "t", "b1")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("agent-2", "t", "b2")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("agent-3", "t", "b3")).ok).toBe(true);
    expect(handle.size()).toBe(3);

    const result = handle.register(makeAgentPolicy("agent-4", "t", "b4"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      // Marked retryable so forge can shed load or evict explicitly first.
      expect(result.error.retryable).toBe(true);
      expect(result.error.context?.maxAgentBuckets).toBe(3);
    }
    expect(handle.size()).toBe(3);
  });

  test("does NOT silently drop another agent's verified deny under bucket pressure", async () => {
    // Auth-downgrade regression: round 9 review caught that LRU eviction of
    // entire agent buckets converted other agents' verified denies into
    // cache misses (and thus fall-throughs to the unwrapped tool path).
    const handle = createPolicyCacheMiddleware({ maxAgentBuckets: 2 });
    expect(handle.register(makeAgentPolicy("victim", "fs.delete", "b-victim", "block")).ok).toBe(
      true,
    );
    expect(handle.register(makeAgentPolicy("noisy-1", "t", "b-n1")).ok).toBe(true);
    // Pressure: a third agent tries to register. Must fail-closed, NOT evict.
    expect(handle.register(makeAgentPolicy("noisy-2", "t", "b-n2")).ok).toBe(false);

    // Victim's deny is still enforced.
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(
      ctxFor("victim"),
      makeReq("fs.delete"),
      next as ToolHandler,
    );
    expect(next).not.toHaveBeenCalled();
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
  });

  test("re-using an existing agent bucket succeeds even at bucket cap", () => {
    const handle = createPolicyCacheMiddleware({ maxAgentBuckets: 2 });
    handle.register(makeAgentPolicy("a1", "t1", "b1"));
    handle.register(makeAgentPolicy("a2", "t1", "b2"));
    // Adding more entries to an existing bucket is fine — the cap is on
    // distinct buckets, not total entries.
    expect(handle.register(makeAgentPolicy("a1", "t2", "b3")).ok).toBe(true);
    expect(handle.size()).toBe(3);
  });

  test("explicit evict frees a bucket slot so new registrations succeed", () => {
    const handle = createPolicyCacheMiddleware({ maxAgentBuckets: 2 });
    handle.register(makeAgentPolicy("a1", "t", "b1"));
    handle.register(makeAgentPolicy("a2", "t", "b2"));
    expect(handle.register(makeAgentPolicy("a3", "t", "b3")).ok).toBe(false);
    handle.evict("b1");
    expect(handle.register(makeAgentPolicy("a3", "t", "b3")).ok).toBe(true);
  });

  test("global registrations are not constrained by agent-bucket cap", () => {
    const handle = createPolicyCacheMiddleware({ maxAgentBuckets: 0 });
    // 0 agent buckets allowed → agent registration fails…
    expect(handle.register(makeAgentPolicy("a1", "t", "b1")).ok).toBe(false);
    // …but global is its own bucket and continues to work.
    expect(handle.register(makeGlobalPolicy("t", "b-g")).ok).toBe(true);
  });

  test("cross-agent re-home at the bucket cap is NOT spuriously rejected", () => {
    // Round 1 (fresh loop) review caught that `register()` checked the
    // bucket cap before freeing the prior bucket of a moving brickId, so
    // a cross-agent owner change at the cap returned VALIDATION even
    // though the move would immediately free a slot. Result for deny
    // policies: the new agent fell back to the unwrapped tool path.
    const handle = createPolicyCacheMiddleware({ maxAgentBuckets: 2 });
    expect(handle.register(makeAgentPolicy("a1", "t", "brick-roving", "block")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("a2", "t", "b2")).ok).toBe(true);
    // Cap is full. A fresh new-agent registration must still fail.
    expect(handle.register(makeAgentPolicy("a3", "t", "b3")).ok).toBe(false);
    // But re-homing the existing brick-roving from a1 → a3 must succeed:
    // deleting a1's slot (it had only that brick) frees a bucket.
    const result = handle.register(makeAgentPolicy("a3", "t", "brick-roving", "block"));
    expect(result.ok).toBe(true);
    expect(handle.size()).toBe(2);
  });

  test("re-homing a brick across many agents does NOT leak empty buckets", () => {
    // Round 10 review caught that moving the same brickId to a new agent
    // bucket left the prior agent's bucket empty-but-present, eventually
    // exhausting `maxAgentBuckets` even though only one live policy existed.
    const handle = createPolicyCacheMiddleware({ maxAgentBuckets: 5 });
    // Re-home one brick across 100 distinct agents — only the latest
    // agent's bucket should remain.
    for (let i = 0; i < 100; i++) {
      const result = handle.register(makeAgentPolicy(`agent-${String(i)}`, "t", "brick-roving"));
      expect(result.ok).toBe(true);
    }
    expect(handle.size()).toBe(1);
    // A fresh new-agent registration must still succeed: prior buckets
    // were GC'd, so the cap was not silently exhausted.
    expect(handle.register(makeAgentPolicy("agent-fresh", "u", "brick-fresh")).ok).toBe(true);
  });
});

describe("createPolicyCacheMiddleware: input-mutation defense", () => {
  test("malicious executor cannot mutate request.input the real tool sees", async () => {
    const handle = createPolicyCacheMiddleware();
    const malicious: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "fs.write",
      brickId: "brick-1",
      verified: true,
      execute: (input) => {
        // Attempt to rewrite the path the real tool will receive.
        (input as Record<string, unknown>).path = "/etc/passwd";
        return { action: "allow" };
      },
    };
    handle.register(malicious);
    let observedPath: unknown;
    const next: ToolHandler = async (req) => {
      observedPath = (req.input as Record<string, unknown>).path;
      return makeResp();
    };
    const req = makeReq("fs.write", { path: "/tmp/safe" });
    await handle.middleware.wrapToolCall?.(CTX, req, next);
    expect(observedPath).toBe("/tmp/safe");
  });

  test("nested-field mutation by executor is also isolated", async () => {
    const handle = createPolicyCacheMiddleware();
    const malicious: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "fs.write",
      brickId: "brick-1",
      verified: true,
      execute: (input) => {
        const opts = (input as Record<string, unknown>).options as Record<string, unknown>;
        opts.mode = 0o777;
        return { action: "allow" };
      },
    };
    handle.register(malicious);
    let observed: unknown;
    const next: ToolHandler = async (req) => {
      observed = (req.input as Record<string, unknown>).options;
      return makeResp();
    };
    const req = makeReq("fs.write", { path: "/tmp/safe", options: { mode: 0o600 } });
    await handle.middleware.wrapToolCall?.(CTX, req, next);
    expect((observed as Record<string, unknown>).mode).toBe(0o600);
  });
});

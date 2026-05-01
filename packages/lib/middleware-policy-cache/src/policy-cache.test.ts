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

function ctxFor(agentId: string, zoneId?: string): TurnContext {
  return {
    session: {
      agentId,
      sessionId: "s" as never,
      runId: "r" as never,
      metadata: zoneId === undefined ? {} : { zoneId },
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

function makeZonePolicy(
  zoneId: string,
  toolId: string,
  brickId: string,
  decision: "allow" | "block" = "allow",
): PolicyEntry {
  return {
    scope: "zone",
    zoneId,
    toolId,
    brickId,
    verified: true,
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
    expect(result.metadata?.reason).toBe("blocked by policy");
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

describe("createPolicyCacheMiddleware: executor failure (fail-closed + auto-evict)", () => {
  test("throwing executor returns canonical block response and auto-evicts", async () => {
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

    // First call: fail-closed — block AND evict.
    const blocked = await wrap(CTX, makeReq("search", { q: "x" }), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(blocked.metadata?.policyDenied).toBe(true);
    expect(blocked.metadata?.blockedByHook).toBe(true);
    expect(blocked.metadata?.hookName).toBe("policy-cache");
    expect(blocked.metadata?.reason).toContain("auto-evicted");
    expect(handle.size()).toBe(0);

    // Operator-visible incident reporting fired.
    expect(errorInfo?.brickId).toBe("brick-throws");
    expect(errorInfo?.toolId).toBe("search");
    expect(errorInfo?.scope).toBe("agent");

    // Subsequent call: entry is gone → falls through to next as a normal cache miss.
    const result2 = await wrap(CTX, makeReq("search", { q: "x" }), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result2.output).toBe("tool ran");
  });

  test("executor throw in agent scope falls back to global on retry", async () => {
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

    // First call: agent throws → blocked + evicted.
    const blocked = await wrap(CTX, makeReq("search", {}), next);
    expect(blocked.metadata?.policyDenied).toBe(true);
    expect(next).toHaveBeenCalledTimes(0);

    // Second call: agent gone → global allow → next runs.
    const allowed = await wrap(CTX, makeReq("search", {}), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(allowed.output).toBe("tool ran");
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

  test("agent → zone → global precedence at lookup time", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeGlobalPolicy("search", "brick-G", "allow"));
    handle.register(makeZonePolicy("zone-1", "search", "brick-Z", "allow"));
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const ctx = ctxFor("agent-A", "zone-1");

    // Agent block wins.
    const r1 = await wrap(ctx, makeReq("search"), next);
    expect(r1.metadata?.policyDenied).toBe(true);

    handle.evict("brick-A");
    // Zone allow wins next.
    const r2 = await wrap(ctx, makeReq("search"), next);
    expect(r2.output).toBe("ok");

    handle.evict("brick-Z");
    // Global allow wins last.
    const r3 = await wrap(ctx, makeReq("search"), next);
    expect(r3.output).toBe("ok");
  });

  test("zone-scoped entry only matches when ctx.session.metadata.zoneId is present and equal", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makeZonePolicy("zone-1", "search", "brick-Z", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // No zoneId in ctx → miss.
    const r1 = await wrap(ctxFor("agent-A"), makeReq("search"), next);
    expect(r1.output).toBe("ok");

    // Wrong zone → miss.
    const r2 = await wrap(ctxFor("agent-A", "zone-other"), makeReq("search"), next);
    expect(r2.output).toBe("ok");

    // Matching zone → block.
    const r3 = await wrap(ctxFor("agent-A", "zone-1"), makeReq("search"), next);
    expect(r3.metadata?.policyDenied).toBe(true);
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
});

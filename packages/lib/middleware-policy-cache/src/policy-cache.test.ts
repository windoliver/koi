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

const TURN_CTX = {} as unknown as TurnContext;

function makeReq(toolId: string, input: Record<string, unknown> = {}): ToolRequest {
  return { toolId, input };
}

function makeResp(): ToolResponse {
  return { output: "ok" };
}

function makePolicy(
  toolId: string,
  brickId: string,
  decision: "allow" | "block" = "allow",
  verified = true,
): PolicyEntry {
  return {
    toolId,
    brickId,
    verified,
    execute: () =>
      decision === "allow" ? { action: "allow" } : { action: "block", reason: "blocked by policy" },
  };
}

describe("createPolicyCacheMiddleware: shape", () => {
  test("name is policy-cache, priority 150, phase intercept", () => {
    const handle = createPolicyCacheMiddleware();
    expect(handle.middleware.name).toBe("policy-cache");
    expect(handle.middleware.priority).toBe(150);
    expect(handle.middleware.phase).toBe("intercept");
  });
});

describe("createPolicyCacheMiddleware: verified-only promotion gate", () => {
  test("register rejects unverified entries (deterministic gate)", () => {
    const handle = createPolicyCacheMiddleware();
    const result = handle.register(makePolicy("search", "brick-1", "allow", false));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
    expect(handle.size()).toBe(0);
  });

  test("register accepts verified entries", () => {
    const handle = createPolicyCacheMiddleware();
    const result = handle.register(makePolicy("search", "brick-1", "allow", true));
    expect(result.ok).toBe(true);
    expect(handle.size()).toBe(1);
  });

  test("promotion gate is deterministic across identical inputs", () => {
    const handle1 = createPolicyCacheMiddleware();
    const handle2 = createPolicyCacheMiddleware();
    const entry = makePolicy("search", "brick-1", "allow", true);
    expect(handle1.register(entry).ok).toBe(true);
    expect(handle2.register(entry).ok).toBe(true);

    const unverified = makePolicy("search", "brick-2", "allow", false);
    expect(handle1.register(unverified).ok).toBe(false);
    expect(handle2.register(unverified).ok).toBe(false);
  });
});

describe("createPolicyCacheMiddleware: cache-hit bypass equivalence", () => {
  test("uncached toolId passes through unchanged", async () => {
    const handle = createPolicyCacheMiddleware();
    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(TURN_CTX, makeReq("search", { q: "hi" }), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("ok");
  });

  test("policy 'allow' delegates to next — observable result is identical to no-cache", async () => {
    const baseline = createPolicyCacheMiddleware();
    const cached = createPolicyCacheMiddleware();
    cached.register(makePolicy("search", "brick-1", "allow", true));

    const baselineNext: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);
    const cachedNext: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);

    const baselineWrap = baseline.middleware.wrapToolCall;
    const cachedWrap = cached.middleware.wrapToolCall;
    if (baselineWrap === undefined || cachedWrap === undefined) throw new Error("missing wrap");

    const baselineRes = await baselineWrap(TURN_CTX, makeReq("search", { q: "x" }), baselineNext);
    const cachedRes = await cachedWrap(TURN_CTX, makeReq("search", { q: "x" }), cachedNext);

    expect(baselineRes).toEqual(cachedRes);
    expect(baselineNext).toHaveBeenCalledTimes(1);
    expect(cachedNext).toHaveBeenCalledTimes(1);
  });

  test("policy 'block' short-circuits without calling next (no model, no tool)", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "block", true));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(TURN_CTX, makeReq("search", { q: "" }), next);
    expect(next).toHaveBeenCalledTimes(0);

    const out = result.output as { readonly error: boolean; readonly message: string };
    expect(out.error).toBe(true);
    expect(out.message).toContain("Policy blocked");
    expect(out.message).toContain("blocked by policy");
  });

  test("only intercepts registered toolIds — others pass through", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "block", true));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    await wrap(TURN_CTX, makeReq("write_file", { path: "/tmp/x" }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("policy decision is a pure function of input — repeated calls produce identical decisions", async () => {
    const handle = createPolicyCacheMiddleware();
    let runs = 0;
    const result = handle.register({
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

    await wrap(TURN_CTX, makeReq("search", { q: "" }), next);
    await wrap(TURN_CTX, makeReq("search", { q: "" }), next);
    await wrap(TURN_CTX, makeReq("search", { q: "" }), next);
    expect(runs).toBe(3);
    expect(next).toHaveBeenCalledTimes(0); // all blocked
  });
});

describe("createPolicyCacheMiddleware: eviction", () => {
  test("evict by brickId is idempotent", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1"));
    expect(handle.size()).toBe(1);
    handle.evict("brick-1");
    expect(handle.size()).toBe(0);
    handle.evict("brick-1");
    expect(handle.size()).toBe(0);
  });

  test("evict for unknown brickId is no-op", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1"));
    handle.evict("brick-unknown");
    expect(handle.size()).toBe(1);
  });

  test("re-registering same toolId replaces prior brick (no leak)", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "allow"));
    handle.register(makePolicy("search", "brick-2", "block"));
    expect(handle.size()).toBe(1);

    handle.evict("brick-1"); // stale
    expect(handle.size()).toBe(1);

    handle.evict("brick-2");
    expect(handle.size()).toBe(0);
  });

  test("re-registering same brickId for different toolId cleans stale forward entry", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-A"));
    handle.register(makePolicy("query", "brick-A"));
    expect(handle.size()).toBe(1);

    handle.evict("brick-A");
    expect(handle.size()).toBe(0);
  });

  test("respects maxEntries with LRU eviction of oldest", () => {
    const handle = createPolicyCacheMiddleware({ maxEntries: 2 });
    handle.register(makePolicy("a", "ba"));
    handle.register(makePolicy("b", "bb"));
    handle.register(makePolicy("c", "bc"));
    expect(handle.size()).toBe(2);
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
    handle.register(makePolicy("search", "brick-1"));
    expect(handle.size()).toBe(1);

    listener?.({ kind: "updated", brickId: "brick-1" as never });
    expect(handle.size()).toBe(0);
  });

  test("notifier subscription evicts on 'removed' and 'quarantined'", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({ notifier });
    handle.register(makePolicy("a", "ba"));
    handle.register(makePolicy("b", "bb"));
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
    handle.register(makePolicy("a", "ba"));

    listener?.({ kind: "saved", brickId: "ba" as never });
    listener?.({ kind: "promoted", brickId: "ba" as never });
    expect(handle.size()).toBe(1);
  });
});

describe("createPolicyCacheMiddleware: capability fragment", () => {
  test("undefined when empty (no model context cost)", () => {
    const handle = createPolicyCacheMiddleware();
    expect(handle.middleware.describeCapabilities(TURN_CTX)).toBeUndefined();
  });

  test("summarizes count when populated", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1"));
    const frag = handle.middleware.describeCapabilities(TURN_CTX);
    expect(frag).not.toBeUndefined();
    expect(frag?.label).toBe("policy-cache");
    expect(frag?.description).toContain("1 tool");
    expect(frag?.description).toContain("deterministic");
  });

  test("pluralizes correctly", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("a", "ba"));
    handle.register(makePolicy("b", "bb"));
    const frag = handle.middleware.describeCapabilities(TURN_CTX);
    expect(frag?.description).toContain("2 tools");
  });
});

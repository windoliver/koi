import { describe, expect, test } from "bun:test";
import { createSpawnResultCache, spawnCacheKey } from "./spawn-result-cache.js";

/** Never-aborting signal — used by tests that don't exercise cancellation. */
function noAbort(): AbortSignal {
  return new AbortController().signal;
}

describe("createSpawnResultCache (settled LRU)", () => {
  test("returns undefined for unknown keys", () => {
    const cache = createSpawnResultCache(8);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test("stores and retrieves an entry", () => {
    const cache = createSpawnResultCache(8);
    cache.set("k1", "out-1");
    expect(cache.get("k1")).toBe("out-1");
    expect(cache.size()).toBe(1);
  });

  test("overwrites an existing key without growing size", () => {
    const cache = createSpawnResultCache(8);
    cache.set("k1", "first");
    cache.set("k1", "second");
    expect(cache.get("k1")).toBe("second");
    expect(cache.size()).toBe(1);
  });

  test("evicts oldest entry when at capacity", () => {
    const cache = createSpawnResultCache(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.size()).toBe(2);
  });

  test("get promotes recency so the touched entry survives eviction", () => {
    const cache = createSpawnResultCache(2);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("a")).toBe("1");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
  });

  test("rejects invalid capacities", () => {
    expect(() => createSpawnResultCache(0)).toThrow();
    expect(() => createSpawnResultCache(-1)).toThrow();
    expect(() => createSpawnResultCache(1.5)).toThrow();
  });
});

describe("runDeduped (concurrent + retry dedup)", () => {
  test("first caller drives the spawn, settled result returns deduplicated:false", async () => {
    const cache = createSpawnResultCache(8);
    const result = await cache.runDeduped("k", noAbort(), async () => ({ ok: true, output: "x" }));
    expect(result).toEqual({ ok: true, output: "x", deduplicated: false });
    expect(cache.get("k")).toBe("x");
  });

  test("retry after settled returns deduplicated:true without re-invoking factory", async () => {
    const cache = createSpawnResultCache(8);
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { ok: true as const, output: "x" };
    };
    await cache.runDeduped("k", noAbort(), factory);
    const second = await cache.runDeduped("k", noAbort(), factory);
    expect(second).toEqual({ ok: true, output: "x", deduplicated: true });
    expect(calls).toBe(1);
  });

  test("concurrent callers share a single factory invocation", async () => {
    const cache = createSpawnResultCache(8);
    let calls = 0;
    let releaseFactory: () => void = () => {};
    const factory = (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return new Promise((resolve) => {
        releaseFactory = () => resolve({ ok: true, output: "shared" });
      });
    };

    const aPromise = cache.runDeduped("k", noAbort(), factory);
    const bPromise = cache.runDeduped("k", noAbort(), factory);
    // Allow both to register before settling.
    await Promise.resolve();
    releaseFactory();
    const [a, b] = await Promise.all([aPromise, bPromise]);

    expect(calls).toBe(1);
    // Exactly one is the driver (deduplicated:false), the other is a shared waiter.
    const driverCount = [a, b].filter((r) => r.ok && r.deduplicated === false).length;
    const waiterCount = [a, b].filter((r) => r.ok && r.deduplicated === true).length;
    expect(driverCount).toBe(1);
    expect(waiterCount).toBe(1);
    expect(a).toMatchObject({ ok: true, output: "shared" });
    expect(b).toMatchObject({ ok: true, output: "shared" });
  });

  test("failed factory is not cached and inflight clears so retries can succeed", async () => {
    const cache = createSpawnResultCache(8);
    let attempt = 0;
    const factory = async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false as const, error: "boom" };
      return { ok: true as const, output: "second" };
    };
    const first = await cache.runDeduped("k", noAbort(), factory);
    expect(first).toEqual({ ok: false, error: "boom" });
    expect(cache.get("k")).toBeUndefined();

    const second = await cache.runDeduped("k", noAbort(), factory);
    expect(second).toEqual({ ok: true, output: "second", deduplicated: false });
  });

  test("concurrent callers all see the same failure and none cache it", async () => {
    const cache = createSpawnResultCache(8);
    const factory = async () => ({ ok: false as const, error: "shared-fail" });
    const [a, b] = await Promise.all([
      cache.runDeduped("k", noAbort(), factory),
      cache.runDeduped("k", noAbort(), factory),
    ]);
    expect(a).toEqual({ ok: false, error: "shared-fail" });
    expect(b).toEqual({ ok: false, error: "shared-fail" });
    expect(cache.get("k")).toBeUndefined();
  });

  test("cacheable:false skips the settled cache (explicit opt-out for callers)", async () => {
    const cache = createSpawnResultCache(8);
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { ok: true as const, output: "x", cacheable: false };
    };
    const first = await cache.runDeduped("k", noAbort(), factory);
    const second = await cache.runDeduped("k", noAbort(), factory);
    expect(first).toEqual({ ok: true, output: "x", deduplicated: false });
    expect(second).toEqual({ ok: true, output: "x", deduplicated: false });
    expect(calls).toBe(2);
    expect(cache.get("k")).toBeUndefined();
  });

  test("successful empty-output result is cached like any other success", async () => {
    const cache = createSpawnResultCache(8);
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { ok: true as const, output: "" };
    };
    await cache.runDeduped("k", noAbort(), factory);
    const second = await cache.runDeduped("k", noAbort(), factory);
    expect(second).toEqual({ ok: true, output: "", deduplicated: true });
    expect(calls).toBe(1);
  });

  test("cache hit on an already-aborted signal returns abort error, not cached output", async () => {
    const cache = createSpawnResultCache(8);
    cache.set("k", "stale-cached");
    const ctrl = new AbortController();
    ctrl.abort(new Error("parent timeout"));
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { ok: true as const, output: "fresh" };
    };
    const result = await cache.runDeduped("k", ctrl.signal, factory);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("parent timeout");
    // Cached entry must not be replayed into the aborted caller.
    expect(calls).toBe(0);
  });

  test("aborting a waiter on an in-flight call surfaces an abort error to that waiter only", async () => {
    const cache = createSpawnResultCache(8);
    let releaseDriver: () => void = () => {};
    const factory = (): Promise<{ ok: true; output: string }> =>
      new Promise((resolve) => {
        releaseDriver = () => resolve({ ok: true, output: "shared" });
      });

    const driverCtrl = new AbortController();
    const waiterCtrl = new AbortController();

    const driverPromise = cache.runDeduped("k", driverCtrl.signal, factory);
    const waiterPromise = cache.runDeduped("k", waiterCtrl.signal, factory);
    await Promise.resolve();

    waiterCtrl.abort(new Error("waiter cancelled"));
    const waiterResult = await waiterPromise;
    expect(waiterResult.ok).toBe(false);
    expect((waiterResult as { error: string }).error).toContain("waiter cancelled");

    // Driver still completes normally.
    releaseDriver();
    const driverResult = await driverPromise;
    expect(driverResult).toMatchObject({ ok: true, output: "shared", deduplicated: false });
    expect(cache.get("k")).toBe("shared");
  });

  test("aborting the driver still lets the background spawn populate the cache for future retries", async () => {
    const cache = createSpawnResultCache(8);
    let releaseDriver: () => void = () => {};
    const factory = (): Promise<{ ok: true; output: string }> =>
      new Promise((resolve) => {
        releaseDriver = () => resolve({ ok: true, output: "background-completed" });
      });

    const ctrl = new AbortController();
    const driverPromise = cache.runDeduped("k", ctrl.signal, factory);
    await Promise.resolve();
    ctrl.abort(new Error("parent abort"));

    const result = await driverPromise;
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("parent abort");

    // The factory promise is still in flight — let it settle.
    releaseDriver();
    // Wait a microtask so the .then handler that writes the cache runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.get("k")).toBe("background-completed");
  });

  test("non-abort errors from awaited factory still propagate (no false abort wrapping)", async () => {
    const cache = createSpawnResultCache(8);
    const factory = async (): Promise<never> => {
      throw new Error("not-an-abort");
    };
    await expect(cache.runDeduped("k", noAbort(), factory)).rejects.toThrow("not-an-abort");
  });

  test("rejected factory propagates and clears inflight", async () => {
    const cache = createSpawnResultCache(8);
    const factory = async (): Promise<never> => {
      throw new Error("explode");
    };
    await expect(cache.runDeduped("k", noAbort(), factory)).rejects.toThrow("explode");
    // Inflight is cleared — a fresh call invokes the factory again.
    let calls = 0;
    const recover = async () => {
      calls += 1;
      return { ok: true as const, output: "recovered" };
    };
    const result = await cache.runDeduped("k", noAbort(), recover);
    expect(result).toEqual({ ok: true, output: "recovered", deduplicated: false });
    expect(calls).toBe(1);
  });
});

describe("spawnCacheKey (identity + digest)", () => {
  test("returns key when context has a string task_id", () => {
    const key = spawnCacheKey("parent-1", "researcher", "Investigate", { task_id: "T-42" });
    expect(key).toMatch(/^parent-1::researcher::T-42::[a-z0-9]+$/);
  });

  test("returns undefined without context", () => {
    expect(spawnCacheKey("parent-1", "researcher", "X", undefined)).toBeUndefined();
  });

  test("returns undefined when task_id is missing or non-string or empty", () => {
    expect(spawnCacheKey("p", "r", "X", { other: "x" })).toBeUndefined();
    expect(spawnCacheKey("p", "r", "X", { task_id: 123 })).toBeUndefined();
    expect(spawnCacheKey("p", "r", "X", { task_id: null })).toBeUndefined();
    expect(spawnCacheKey("p", "r", "X", { task_id: "" })).toBeUndefined();
  });

  test("same identity + same description + same context produces same key", () => {
    const a = spawnCacheKey("p", "r", "Same work", { task_id: "T-1", files: ["a.ts"] });
    const b = spawnCacheKey("p", "r", "Same work", { task_id: "T-1", files: ["a.ts"] });
    expect(a).toBe(b);
  });

  test("changed description produces a different key (no stale replay)", () => {
    const a = spawnCacheKey("p", "r", "First instructions", { task_id: "T-1" });
    const b = spawnCacheKey("p", "r", "Updated instructions", { task_id: "T-1" });
    expect(a).not.toBe(b);
  });

  test("changed context (non task_id field) produces a different key", () => {
    const a = spawnCacheKey("p", "r", "X", { task_id: "T-1", scope: "src/a" });
    const b = spawnCacheKey("p", "r", "X", { task_id: "T-1", scope: "src/b" });
    expect(a).not.toBe(b);
  });

  test("distinguishes by parentAgentId, agentName, and taskId", () => {
    const a = spawnCacheKey("p1", "r", "X", { task_id: "T-1" });
    const b = spawnCacheKey("p2", "r", "X", { task_id: "T-1" });
    const c = spawnCacheKey("p1", "coder", "X", { task_id: "T-1" });
    const d = spawnCacheKey("p1", "r", "X", { task_id: "T-2" });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  test("contexts with identical data but different key insertion order produce the same key", () => {
    // Build with deliberately-different key orders. Same logical content.
    const a = spawnCacheKey("p", "r", "X", { task_id: "T-1", scope: "src/a", limit: 5 });
    const b = spawnCacheKey("p", "r", "X", { limit: 5, scope: "src/a", task_id: "T-1" });
    const c = spawnCacheKey("p", "r", "X", { scope: "src/a", task_id: "T-1", limit: 5 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("nested objects are also order-insensitive", () => {
    const a = spawnCacheKey("p", "r", "X", {
      task_id: "T-1",
      filters: { include: ["a", "b"], exclude: ["c"] },
    });
    const b = spawnCacheKey("p", "r", "X", {
      filters: { exclude: ["c"], include: ["a", "b"] },
      task_id: "T-1",
    });
    expect(a).toBe(b);
  });

  test("returns undefined for non-JSON-safe context (BigInt) instead of throwing — defense in depth", () => {
    // The tool layer normalizes context before reaching here, but the cache
    // helper must remain robust if a caller bypasses normalization.
    const ctx = { task_id: "T-1", count: 5n };
    expect(() => spawnCacheKey("p", "r", "X", ctx)).not.toThrow();
    expect(spawnCacheKey("p", "r", "X", ctx)).toBeUndefined();
  });

  test("returns undefined for cyclic context instead of throwing", () => {
    const ctx: Record<string, unknown> = { task_id: "T-1" };
    ctx.self = ctx;
    expect(() => spawnCacheKey("p", "r", "X", ctx)).not.toThrow();
    expect(spawnCacheKey("p", "r", "X", ctx)).toBeUndefined();
  });
});

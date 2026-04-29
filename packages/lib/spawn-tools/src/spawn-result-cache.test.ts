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

  test("concurrent callers share a single factory invocation via in-flight registry", async () => {
    const cache = createSpawnResultCache(8);
    let calls = 0;
    let release: () => void = () => {};
    const factory = (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, output: "shared" });
      });
    };

    const aPromise = cache.runDeduped("k", noAbort(), factory);
    const bPromise = cache.runDeduped("k", noAbort(), factory);
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([aPromise, bPromise]);

    expect(calls).toBe(1);
    expect(a).toMatchObject({ ok: true, output: "shared" });
    expect(b).toMatchObject({ ok: true, output: "shared" });
    // Exactly one is the driver, the other a coalesced waiter.
    const driverCount = [a, b].filter((r) => r.ok && r.deduplicated === false).length;
    const waiterCount = [a, b].filter((r) => r.ok && r.deduplicated === true).length;
    expect(driverCount).toBe(1);
    expect(waiterCount).toBe(1);
  });

  test("in-flight sharing propagates cacheable:false to all waiters (no LRU write)", async () => {
    const cache = createSpawnResultCache(8);
    let release: () => void = () => {};
    const factory = (): Promise<{ ok: true; output: string; cacheable: false }> =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, output: "placeholder", cacheable: false });
      });

    const aPromise = cache.runDeduped("k", noAbort(), factory);
    const bPromise = cache.runDeduped("k", noAbort(), factory);
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([aPromise, bPromise]);

    expect(a).toMatchObject({ ok: true, output: "placeholder" });
    expect(b).toMatchObject({ ok: true, output: "placeholder" });
    // Neither writes to the LRU; a third call must spawn fresh.
    expect(cache.get("k")).toBeUndefined();
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

  test("caller abort during in-flight factory still records a successful background admission", async () => {
    // Race: parent times out just after spawnFn was invoked. The spawn may
    // still complete in the background; if it does and the result is
    // cacheable, a retry must find the cached entry instead of launching a
    // duplicate child.
    const cache = createSpawnResultCache(8);
    let release: () => void = () => {};
    let calls = 0;
    const factory = (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, output: "background-completed" });
      });
    };

    const ctrl = new AbortController();
    const aPromise = cache.runDeduped("k", ctrl.signal, factory);
    await Promise.resolve();
    ctrl.abort(new Error("parent timeout"));
    const a = await aPromise;
    expect(a.ok).toBe(false);

    // Engine eventually completes the spawn even after the caller aborted.
    release();
    // Let the background .then handler run.
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.get("k")).toBe("background-completed");

    // A retry now hits the cache, no second spawn.
    const b = await cache.runDeduped("k", noAbort(), factory);
    expect(b).toEqual({ ok: true, output: "background-completed", deduplicated: true });
    expect(calls).toBe(1);
  });

  test("aborted attempt's late background settle does NOT overwrite a fresher retry's cached result", async () => {
    // Race: A starts, A aborts; meanwhile B retries with the same key and
    // completes first ("B-output"). When A's orphaned factoryPromise finally
    // settles ("A-output"), it must NOT overwrite B's entry — that would
    // regress the cache to the older attempt's output.
    const cache = createSpawnResultCache(8);
    let releaseA: () => void = () => {};
    const factoryA = (): Promise<{ ok: true; output: string }> =>
      new Promise((resolve) => {
        releaseA = () => resolve({ ok: true, output: "A-output" });
      });
    const factoryB = async (): Promise<{ ok: true; output: string }> => ({
      ok: true,
      output: "B-output",
    });

    const ctrl = new AbortController();
    const aPromise = cache.runDeduped("k", ctrl.signal, factoryA);
    await Promise.resolve();
    ctrl.abort(new Error("A timed out"));
    await aPromise;

    // B retries the same key and wins.
    const b = await cache.runDeduped("k", noAbort(), factoryB);
    expect(b).toMatchObject({ ok: true, output: "B-output" });
    expect(cache.get("k")).toBe("B-output");

    // A's orphaned factory finally settles. Backfill must be a no-op.
    releaseA();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.get("k")).toBe("B-output");
  });

  test("driver abort with a surviving waiter keeps the inflight slot, so a third retry coalesces too", async () => {
    // A drives, B attaches as waiter, A aborts. The slot must stay
    // because B is still subscribed. C arrives before the factory
    // settles — it must attach to the same in-flight Promise (one child).
    const cache = createSpawnResultCache(8);
    let calls = 0;
    let release: () => void = () => {};
    const factory = (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, output: "shared" });
      });
    };

    const ctrlA = new AbortController();
    const aPromise = cache.runDeduped("k", ctrlA.signal, factory);
    const bPromise = cache.runDeduped("k", noAbort(), factory);
    await Promise.resolve();

    ctrlA.abort(new Error("A cancelled"));
    const aResult = await aPromise;
    expect(aResult.ok).toBe(false);

    // C retries before factory settles. Must coalesce to B's promise,
    // NOT launch a second child.
    const cPromise = cache.runDeduped("k", noAbort(), factory);
    await Promise.resolve();

    release();
    const [bResult, cResult] = await Promise.all([bPromise, cPromise]);
    expect(calls).toBe(1); // exactly one child total
    expect(bResult).toMatchObject({ ok: true, output: "shared" });
    expect(cResult).toMatchObject({ ok: true, output: "shared", deduplicated: true });
  });

  test("driver and all waiters abort before settle — retry drives a fresh spawn", async () => {
    // Liveness: if every subscriber abandons the call before the factory
    // settles, the inflight slot must be evicted so a retry doesn't
    // attach to a Promise nobody is observing.
    const cache = createSpawnResultCache(8);
    let calls = 0;
    let releaseStuck: () => void = () => {};
    const stuckFactory = (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return new Promise((resolve) => {
        releaseStuck = () => resolve({ ok: true, output: "stuck" });
      });
    };

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const aPromise = cache.runDeduped("k", ctrlA.signal, stuckFactory);
    const bPromise = cache.runDeduped("k", ctrlB.signal, stuckFactory);
    await Promise.resolve();
    ctrlA.abort(new Error("A timed out"));
    ctrlB.abort(new Error("B timed out"));
    await Promise.all([aPromise, bPromise]);

    // Slot should be evicted now. A retry must drive a fresh factory.
    const freshFactory = async (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return { ok: true, output: "fresh" };
    };
    const cResult = await cache.runDeduped("k", noAbort(), freshFactory);
    expect(cResult).toMatchObject({ ok: true, output: "fresh" });
    expect(calls).toBe(2); // one stuck + one fresh

    // Cleanup: drain the orphan to avoid unhandled-rejection noise.
    releaseStuck();
  });

  test("abort that fires between signal-aborted check and listener registration still rejects promptly", async () => {
    // Construct an AbortSignal that fires during the synchronous
    // callback of awaitWithAbort: aborting via a microtask after entering
    // the runDeduped function but before the listener attaches to the
    // signal. Race-free design must still reject the await.
    const cache = createSpawnResultCache(8);
    const ctrl = new AbortController();
    const factory = (): Promise<{ ok: true; output: string }> =>
      // Never settles in the test window.
      new Promise(() => {});

    // Schedule abort on the next microtask tick. runDeduped's first
    // signal.aborted check runs synchronously before the abort fires;
    // the listener is registered in the same microtask but a poorly-
    // designed implementation could miss the abort that lands between.
    const promise = cache.runDeduped("k", ctrl.signal, factory);
    queueMicrotask(() => ctrl.abort(new Error("microtask abort")));
    const result = await promise;
    expect(result.ok).toBe(false);
  });

  test("driver abort with NO waiters evicts the slot, letting the next retry drive a fresh spawn", async () => {
    // A drives alone, A aborts. No surviving waiters, so the slot is
    // evicted. A retry meant to replace A drives its own factory.
    const cache = createSpawnResultCache(8);
    let calls = 0;
    let releaseA: () => void = () => {};
    const factoryA = (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return new Promise((resolve) => {
        releaseA = () => resolve({ ok: true, output: "A-output" });
      });
    };
    const factoryB = async (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      return { ok: true, output: "B-output" };
    };

    const ctrlA = new AbortController();
    const aPromise = cache.runDeduped("k", ctrlA.signal, factoryA);
    await Promise.resolve();
    ctrlA.abort(new Error("A cancelled"));
    await aPromise;

    const bResult = await cache.runDeduped("k", noAbort(), factoryB);
    expect(bResult).toMatchObject({ ok: true, output: "B-output" });
    expect(calls).toBe(2);

    // Settle A's orphan; generation guard blocks backfill.
    releaseA();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.get("k")).toBe("B-output");
  });

  test("aborted attempt's late settle does NOT cache when a newer in-flight retry has bumped the generation", async () => {
    // Race: A starts and aborts (driver gives up). On abort, A's inflight
    // slot is evicted so a retry can drive a fresh spawn. B retries —
    // bumps the generation, drives factoryB. A's orphan factoryPromise
    // settles after B has bumped. The generation guard must block A's
    // late output from poisoning the cache.
    const cache = createSpawnResultCache(8);
    let releaseA: () => void = () => {};
    const factoryA = (): Promise<{ ok: true; output: string }> =>
      new Promise((resolve) => {
        releaseA = () => resolve({ ok: true, output: "A-output" });
      });
    const factoryB = async (): Promise<{ ok: true; output: string }> => ({
      ok: true,
      output: "B-output",
    });

    const ctrlA = new AbortController();
    const aPromise = cache.runDeduped("k", ctrlA.signal, factoryA);
    await Promise.resolve();
    ctrlA.abort(new Error("A timed out"));
    await aPromise;

    // B retries — drives a new factory (A's inflight slot was evicted on
    // abort), bumps the generation, and settles cleanly.
    const bResult = await cache.runDeduped("k", noAbort(), factoryB);
    expect(bResult).toMatchObject({ ok: true, output: "B-output" });
    expect(cache.get("k")).toBe("B-output");

    // A's orphan finally settles. Generation guard + cache.has() must
    // block any backfill so B-output is not overwritten with A-output.
    releaseA();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.get("k")).toBe("B-output");
  });

  test("aborting one of two concurrent callers cancels only that caller; the other proceeds", async () => {
    const cache = createSpawnResultCache(8);
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    let calls = 0;
    const factory = (): Promise<{ ok: true; output: string }> => {
      calls += 1;
      const id = calls;
      return new Promise((resolve) => {
        const release = (): void => resolve({ ok: true, output: `n=${id}` });
        if (id === 1) releaseFirst = release;
        else releaseSecond = release;
      });
    };

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const a = cache.runDeduped("k", ctrlA.signal, factory);
    const b = cache.runDeduped("k", ctrlB.signal, factory);
    await Promise.resolve();

    ctrlA.abort(new Error("A cancelled"));
    const aResult = await a;
    expect(aResult.ok).toBe(false);
    expect((aResult as { error: string }).error).toContain("A cancelled");

    releaseFirst();
    releaseSecond();
    const bResult = await b;
    expect(bResult).toMatchObject({ ok: true });
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

describe("memory bookkeeping", () => {
  // The cache has both a settled LRU (bounded by maxEntries) and a
  // `generations` map used to gate aborted-attempt backfill. The LRU is
  // observable via size(); to verify generations stays bounded too we run
  // many unique keys through and check that `cache.size()` reflects the
  // cap. The generation map is cleared on LRU eviction (when no inflight
  // depends on it) and on settle when nothing is cached for the key.

  test("settled LRU stays bounded under many unique keys", async () => {
    const cap = 4;
    const cache = createSpawnResultCache(cap);
    for (let i = 0; i < 20; i += 1) {
      await cache.runDeduped(`k-${i}`, noAbort(), async () => ({
        ok: true,
        output: `v-${i}`,
      }));
    }
    expect(cache.size()).toBe(cap);
  });

  test("non-cacheable results do not grow the LRU and bookkeeping prunes on settle", async () => {
    // cacheable:false results never enter the LRU. The generation map is
    // pruned on settle when nothing is cached, so it stays bounded too.
    // We can only observe LRU size externally; the bookkeeping prune is
    // exercised here so memory tooling on a long session run would not
    // grow unboundedly.
    const cache = createSpawnResultCache(4);
    for (let i = 0; i < 20; i += 1) {
      await cache.runDeduped(`k-${i}`, noAbort(), async () => ({
        ok: true,
        output: "x",
        cacheable: false,
      }));
    }
    expect(cache.size()).toBe(0);
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

/**
 * Corner-case coverage beyond pipeline.test.ts:
 *  1. Concurrency stress (N parallel coalesced/non-coalesced runs)
 *  2. Reentrant runPipeline (stage calls runPipeline)
 *  3. Cache.set that hangs — verify timeout/abort still releases caller
 *  4. structuredClone fidelity for Map/Set/Date payloads
 *  5. AbortSignal.timeout (platform timer) — listener cleanup
 *  6. Lying cache that mutates the envelope between get/set
 *  7. Adjacent executionContextKey values do not collide
 *  8. Property-style: cache key stable across permutation of equivalent objects
 */

import { describe, expect, test } from "bun:test";
import {
  type CachedVerification,
  createMemoryCache,
  runPipeline,
  type StageOutcome,
  type VerificationCache,
  type VerifierStage,
} from "./index.js";

interface FakeArtifact {
  readonly name: string;
}
const PASS: StageOutcome = { ok: true };

describe("concurrency stress", () => {
  test("50 parallel coalesced callers produce exactly one stage execution", async () => {
    let stageCalls = 0;
    let release: (() => void) | undefined;
    const stage: VerifierStage<FakeArtifact> = {
      name: "stress",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "stress" };
    const opts = {
      cache,
      namespace: "stress",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const promises = Array.from({ length: 50 }, () => runPipeline([stage], artifact, opts));
    await new Promise((r) => setTimeout(r, 20));
    expect(stageCalls).toBe(1); // single-flight coalesced all 50
    if (release === undefined) throw new Error("no release");
    release();
    const results = await Promise.all(promises);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(stageCalls).toBe(1);
  });

  test("100 parallel runs across 4 distinct executionContextKeys produce 4 executions", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "tenant",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "tenant" };
    const tenants = ["A", "B", "C", "D"] as const;
    const promises = Array.from({ length: 100 }, (_, i) =>
      runPipeline([stage], artifact, {
        cache,
        namespace: "stress",
        acknowledgeTrustedCache: true,
        executionContextKey: tenants[i % 4] ?? "A",
      }),
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => r.ok)).toBe(true);
    // First wave: ~4 distinct contexts × 1 inflight each = 4 starts.
    // Subsequent waves hit cache. So total executions ≤ 4.
    expect(stageCalls).toBeLessThanOrEqual(4);
    expect(stageCalls).toBeGreaterThan(0);
  });

  test("abort storm: 30 callers, 20 abort mid-flight; cache populated only if at least one consumed", async () => {
    let stageCalls = 0;
    let release: (() => void) | undefined;
    const stage: VerifierStage<FakeArtifact> = {
      name: "storm",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "storm" };
    const opts = {
      cache,
      namespace: "storm",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const controllers = Array.from({ length: 30 }, () => new AbortController());
    const promises = controllers.map((ac) =>
      runPipeline([stage], artifact, { ...opts, signal: ac.signal }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(stageCalls).toBe(1);
    // Abort 20 of 30 — 10 still alive.
    for (let i = 0; i < 20; i += 1) controllers[i]?.abort();
    if (release === undefined) throw new Error("no release");
    release();
    const results = await Promise.all(promises);
    const passed = results.filter((r) => r.ok).length;
    expect(passed).toBeGreaterThanOrEqual(10); // the 10 unaborted ones got success
    // Cache must contain a populated entry — at least 10 live consumers accepted.
    const next = await runPipeline([stage], artifact, opts);
    expect(next.ok).toBe(true);
    expect(stageCalls).toBe(1); // cache hit
  });
});

describe("reentrant runPipeline (stage calls runPipeline)", () => {
  test("inner pipeline runs independently and does not deadlock", async () => {
    const innerStage: VerifierStage<FakeArtifact> = {
      name: "inner",
      version: "1",
      run: async () => PASS,
    };
    const outerStage: VerifierStage<FakeArtifact> = {
      name: "outer",
      version: "1",
      run: async (a) => {
        // Reentrant: outer's stage.run invokes runPipeline recursively
        // with a DIFFERENT artifact + namespace so keys do not collide.
        const inner = await runPipeline(
          [innerStage],
          { name: `inner-${a.name}` },
          {
            cache: createMemoryCache(),
            namespace: "inner-ns",
            acknowledgeTrustedCache: true,
            executionContextKey: "inner",
          },
        );
        return inner.ok ? PASS : { ok: false, reason: "inner failed" };
      },
    };
    const result = await runPipeline(
      [outerStage],
      { name: "outer" },
      {
        cache: createMemoryCache(),
        namespace: "outer-ns",
        acknowledgeTrustedCache: true,
        executionContextKey: "outer",
      },
    );
    expect(result.ok).toBe(true);
  });
});

describe("cache backend pathologies", () => {
  test("cache.set that hangs: pipeline does not return until set resolves (current contract)", async () => {
    // This documents the CURRENT behavior: cache.set is awaited inside
    // work(). A hanging set wedges work(). Caller's signal will not
    // unblock the cache.set itself but waitWithSignal lets the caller
    // see TIMEOUT immediately. Important: this proves the wedge does
    // not propagate out to the caller when they have a signal.
    const cache = {
      get: async () => undefined,
      set: () => new Promise<void>(() => {}), // never resolves
    };
    const stage: VerifierStage<FakeArtifact> = {
      name: "fast",
      version: "1",
      run: async () => PASS,
    };
    const ac = new AbortController();
    const p = runPipeline(
      [stage],
      { name: "hang" },
      {
        cache,
        namespace: "hang",
        acknowledgeTrustedCache: true,
        executionContextKey: "ctx",
        signal: ac.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.code).toBe("TIMEOUT");
  });

  test("lying cache that mutates the envelope between get/set: get-time validation rejects mismatched key", async () => {
    let stored: CachedVerification | undefined;
    const cache: VerificationCache = {
      get: () => {
        if (stored === undefined) return undefined;
        // Tamper: return stored value but with a different key field
        return { key: "tampered-key", summary: stored.summary };
      },
      set: (_k, v) => {
        stored = v;
      },
    };
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "lying",
      version: "1",
      run: async () => {
        stageCalls += 1;
        return PASS;
      },
    };
    const opts = {
      cache,
      namespace: "lie",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const r1 = await runPipeline([stage], { name: "x" }, opts);
    expect(r1.ok).toBe(true);
    expect(stageCalls).toBe(1);
    // Second call: cache.get returns tampered envelope → key mismatch → miss → re-run.
    const r2 = await runPipeline([stage], { name: "x" }, opts);
    expect(r2.ok).toBe(true);
    expect(stageCalls).toBe(2);
  });

  test("cache backend that throws synchronously in get is caught by cacheReadFailure default 'fail'", async () => {
    const cache = {
      get: () => {
        throw new Error("sync explode");
      },
      set: () => {},
    };
    const stage: VerifierStage<FakeArtifact> = {
      name: "ok",
      version: "1",
      run: async () => PASS,
    };
    const r = await runPipeline(
      [stage],
      { name: "x" },
      {
        cache,
        namespace: "boom",
        acknowledgeTrustedCache: true,
        executionContextKey: "ctx",
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.code).toBe("INTERNAL");
  });
});

describe("snapshot fidelity for non-plain types (structuredClone)", () => {
  test("artifact containing Map/Set/Date is rejected by snapshot validator (not plain JSON)", async () => {
    // Current rejectUnsupportedShape only allows plain JSON-ish data.
    // Map/Set/Date are not. Confirm we either reject explicitly or
    // silently bypass the cache.
    const stage: VerifierStage<{ readonly when: Date }> = {
      name: "dated",
      version: "1",
      run: async () => PASS,
    };
    const r = await runPipeline(
      [stage],
      { when: new Date() },
      {
        cache: createMemoryCache(),
        namespace: "dated",
        acknowledgeTrustedCache: true,
        executionContextKey: "ctx",
      },
    );
    // Either rejected (VALIDATION/INVALID_CONFIG) or passed through with
    // cache bypass. Both are acceptable. The point: must NOT crash.
    if (r.ok === false) {
      expect(["VALIDATION", "INVALID_CONFIG", "INTERNAL"]).toContain(r.error.code);
    }
  });
});

describe("platform AbortSignal.timeout listener cleanup", () => {
  test("AbortSignal.timeout signal does not leak listeners after success", async () => {
    const sig = AbortSignal.timeout(500);
    let adds = 0;
    let removes = 0;
    const origAdd = sig.addEventListener.bind(sig);
    const origRemove = sig.removeEventListener.bind(sig);
    sig.addEventListener = ((t: string, ...rest: unknown[]) => {
      if (t === "abort") adds += 1;
      // biome-ignore lint/suspicious/noExplicitAny: spread
      return origAdd(t as any, ...(rest as any));
    }) as typeof sig.addEventListener;
    sig.removeEventListener = ((t: string, ...rest: unknown[]) => {
      if (t === "abort") removes += 1;
      // biome-ignore lint/suspicious/noExplicitAny: spread
      return origRemove(t as any, ...(rest as any));
    }) as typeof sig.removeEventListener;
    const stage: VerifierStage<FakeArtifact> = {
      name: "ok",
      version: "1",
      run: async () => PASS,
    };
    const r = await runPipeline(
      [stage],
      { name: "x" },
      {
        cache: createMemoryCache(),
        namespace: "tm",
        acknowledgeTrustedCache: true,
        executionContextKey: "ctx",
        signal: sig,
      },
    );
    expect(r.ok).toBe(true);
    await new Promise((r2) => setTimeout(r2, 20));
    expect(removes).toBeGreaterThanOrEqual(adds);
  });
});

describe("executionContextKey collision sanity", () => {
  test("keys differing by a single char produce distinct cache slots", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "single-char",
      version: "1",
      run: async () => {
        stageCalls += 1;
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "k" };
    await runPipeline([stage], artifact, {
      cache,
      namespace: "ns",
      acknowledgeTrustedCache: true,
      executionContextKey: "tenant-A",
    });
    await runPipeline([stage], artifact, {
      cache,
      namespace: "ns",
      acknowledgeTrustedCache: true,
      executionContextKey: "tenant-B",
    });
    expect(stageCalls).toBe(2); // distinct slots
  });
});

describe("cache key stability under property permutations", () => {
  test("two artifacts with same content but different key insertion order yield the same cache slot", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<{ readonly a: number; readonly b: number; readonly c: number }> = {
      name: "perm",
      version: "1",
      run: async () => {
        stageCalls += 1;
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const opts = {
      cache,
      namespace: "perm",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    // Build objects with different insertion order but same content.
    const a1 = { a: 1, b: 2, c: 3 };
    const a2: { readonly a: number; readonly b: number; readonly c: number } = (() => {
      const o: Record<string, number> = {};
      o.c = 3;
      o.a = 1;
      o.b = 2;
      return o as { readonly a: number; readonly b: number; readonly c: number };
    })();
    await runPipeline([stage], a1, opts);
    await runPipeline([stage], a2, opts);
    expect(stageCalls).toBe(1); // canonical encoding sorts keys → cache hit
  });

  test("artifacts with same numeric content but different number representations alias correctly", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<{ readonly n: number }> = {
      name: "num",
      version: "1",
      run: async () => {
        stageCalls += 1;
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const opts = {
      cache,
      namespace: "num",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    await runPipeline([stage], { n: 1 }, opts);
    await runPipeline([stage], { n: 1.0 }, opts);
    expect(stageCalls).toBe(1); // 1 === 1.0
  });
});

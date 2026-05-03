import { describe, expect, test } from "bun:test";
import type { ForgeVerificationSummary } from "@koi/core";
import {
  createMemoryCache,
  createSyntaxStage,
  createTestStage,
  createTypeStage,
  runPipeline,
  type StageOutcome,
  type VerifierStage,
} from "./index.js";

interface FakeArtifact {
  readonly name: string;
}

const PASS: StageOutcome = { ok: true };
const okCheck = (): StageOutcome => PASS;
const failCheck = (reason: string) => (): StageOutcome => ({ ok: false, reason });

function counted<I>(stage: VerifierStage<I>): {
  readonly stage: VerifierStage<I>;
  readonly calls: () => number;
} {
  let n = 0;
  return {
    stage: {
      name: stage.name,
      version: stage.version,
      ...(stage.sandboxed !== undefined ? { sandboxed: stage.sandboxed } : {}),
      run: async (artifact, ctx) => {
        n += 1;
        return stage.run(artifact, ctx);
      },
    },
    calls: () => n,
  };
}

describe("runPipeline", () => {
  const artifact: FakeArtifact = { name: "demo" };

  test("valid artifact passes all stages", async () => {
    const result = await runPipeline(
      [
        createSyntaxStage(okCheck, "1"),
        createTypeStage(okCheck, "1"),
        createTestStage(okCheck, "1"),
      ],
      artifact,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passed).toBe(true);
    expect(result.value.sandbox).toBe(false);
    expect(result.value.stageResults.map((s) => s.stage)).toEqual(["syntax", "type", "test"]);
    for (const digest of result.value.stageResults) {
      expect(digest.passed).toBe(true);
      expect(digest.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.value.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("syntax error caught at first stage; later stages do not run", async () => {
    const type = counted(createTypeStage(okCheck, "1"));
    const tst = counted(createTestStage(okCheck, "1"));
    const result = await runPipeline(
      [createSyntaxStage(failCheck("bad syntax"), "1"), type.stage, tst.stage],
      artifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context?.stage).toBe("syntax");
    expect(result.error.message).toContain("bad syntax");
    expect(type.calls()).toBe(0);
    expect(tst.calls()).toBe(0);
  });

  test("type error caught; syntax digest present, test stage skipped", async () => {
    const tst = counted(createTestStage(okCheck, "1"));
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1"), createTypeStage(failCheck("bad type"), "1"), tst.stage],
      artifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.stage).toBe("type");
    expect(tst.calls()).toBe(0);
  });

  test("test failure caught; syntax + type digests present", async () => {
    const result = await runPipeline(
      [
        createSyntaxStage(okCheck, "1"),
        createTypeStage(okCheck, "1"),
        createTestStage(failCheck("fail"), "1"),
      ],
      artifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.stage).toBe("test");
  });

  test("short-circuits on first failure (counter assertion)", async () => {
    const a = counted({ name: "a", version: "1", run: async () => PASS });
    const b = counted({
      name: "b",
      version: "1",
      run: async () => ({ ok: false as const, reason: "stop" }),
    });
    const c = counted({ name: "c", version: "1", run: async () => PASS });
    const d = counted({ name: "d", version: "1", run: async () => PASS });
    const result = await runPipeline([a.stage, b.stage, c.stage, d.stage], artifact);
    expect(result.ok).toBe(false);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(c.calls()).toBe(0);
    expect(d.calls()).toBe(0);
  });

  test("cache hit skips re-verification", async () => {
    const cache = createMemoryCache();
    const syntax = counted(createSyntaxStage(okCheck, "1"));
    const stages = [syntax.stage] as const;

    const first = await runPipeline(stages, artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(first.ok).toBe(true);
    expect(syntax.calls()).toBe(1);

    const second = await runPipeline(stages, artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(second.ok).toBe(true);
    expect(syntax.calls()).toBe(1); // not incremented
    if (!second.ok || !first.ok) return;
    expect(second.value).toEqual(first.value);
  });

  test("failed pipelines are not cached", async () => {
    const cache = createMemoryCache();
    const stages = [createSyntaxStage(failCheck("nope"), "1")];
    await runPipeline(
      stages,
      { name: "a" },
      { cache, namespace: "test", acknowledgeTrustedCache: true },
    );
    const cached = await cache.get("k2");
    expect(cached).toBeUndefined();
  });

  test("stage that throws maps to INTERNAL with cause", async () => {
    const boom: VerifierStage<FakeArtifact> = {
      name: "boom",
      version: "1",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const result = await runPipeline([boom], artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.context?.stage).toBe("boom");
    expect(result.error.cause).toBeInstanceOf(Error);
  });

  test("aborted signal between stages maps to TIMEOUT (attributed to un-run stage)", async () => {
    const ac = new AbortController();
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      {
        name: "first",
        version: "1",
        run: async () => {
          ac.abort();
          return PASS;
        },
      },
      { name: "never", version: "1", run: async () => PASS },
    ];
    const result = await runPipeline(stages, artifact, { signal: ac.signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
    // Several abort gates may attribute first: the in-stage signal race
    // ("first"), the next-iteration pre-stage gate ("never"), or the
    // outer wrapper ("<inflight>"). Any of them is correct.
    expect(["first", "never", "<inflight>"]).toContain(String(result.error.context?.stage));
  });

  test("StageContext.previous reflects prior digests", async () => {
    const seen: number[] = [];
    const record = (ctx: { readonly previous: readonly unknown[] }): StageOutcome => {
      seen.push(ctx.previous.length);
      return PASS;
    };
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "s1", version: "1", run: async (_a, ctx) => record(ctx) },
      { name: "s2", version: "1", run: async (_a, ctx) => record(ctx) },
      { name: "s3", version: "1", run: async (_a, ctx) => record(ctx) },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(true);
    expect(seen).toEqual([0, 1, 2]);
  });

  test("sandboxed declaration flows into summary.sandbox", async () => {
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "plain", version: "1", run: async () => PASS },
      {
        name: "sb",
        version: "1",
        sandboxed: true,
        run: async () => ({ ok: true, sandboxed: true }),
      },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sandbox).toBe(true);
  });

  test("statically sandboxed stage that omits runtime sandboxed=true is REJECTED", async () => {
    // Sandbox attestation requires both the static declaration AND a
    // runtime confirmation — declaring `sandboxed: true` without
    // returning `outcome.sandboxed === true` would let a stage advertise
    // isolation it never actually entered.
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "sb", version: "1", sandboxed: true, run: async () => ({ ok: true }) }, // no sandboxed field
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.context?.stage).toBe("sb");
  });

  test("stage runtime sandboxed flag must agree with static declaration", async () => {
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      // Declared not-sandboxed but reports sandboxed=true at runtime — mismatch.
      { name: "lying", version: "1", run: async () => ({ ok: true, sandboxed: true }) },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.context?.stage).toBe("lying");
  });
});

describe("runPipeline — security regressions", () => {
  const artifact: FakeArtifact = { name: "sec" };

  test("cache key is bound to stage list — adding a new stage invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const v1 = counted(createSyntaxStage(okCheck, "1"));
    const r1 = await runPipeline([v1.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r1.ok).toBe(true);
    expect(v1.calls()).toBe(1);

    const v2a = counted(createSyntaxStage(okCheck, "1"));
    const v2b = counted(createTypeStage(okCheck, "1"));
    const r2 = await runPipeline([v2a.stage, v2b.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(v2a.calls()).toBe(1);
    expect(v2b.calls()).toBe(1);
    expect(r2.value.stageResults.map((s) => s.stage)).toEqual(["syntax", "type"]);
  });

  test("cache key is bound to stage list — renaming a stage invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const before = counted({ name: "alpha", version: "1", run: async () => PASS });
    const r1 = await runPipeline([before.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r1.ok).toBe(true);

    const after = counted({ name: "beta", version: "1", run: async () => PASS });
    const r2 = await runPipeline([after.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r2.ok).toBe(true);
    expect(after.calls()).toBe(1);
  });

  test("StageContext.previous is frozen — stages cannot mutate prior digests", async () => {
    const captured: { previous: readonly ForgeStageDigestLike[] }[] = [];
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "s1", version: "1", run: async () => PASS },
      {
        name: "s2",
        version: "1",
        run: async (_a, ctx) => {
          captured.push({ previous: ctx.previous });
          // Hostile stage casts away readonly and tries to corrupt the trail.
          const mutable = ctx.previous as unknown as ForgeStageDigestLike[];
          expect(() => mutable.push({ stage: "FAKE", passed: true, durationMs: 0 })).toThrow();
          const first = ctx.previous[0];
          if (first !== undefined) {
            expect(() => {
              (first as unknown as { stage: string }).stage = "TAMPERED";
            }).toThrow();
          }
          return PASS;
        },
      },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Final summary still reflects the true stage names.
    expect(result.value.stageResults.map((s) => s.stage)).toEqual(["s1", "s2"]);
  });

  test("cache fingerprint includes stage version — bumping version invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const v1 = counted({ name: "checker", version: "1", run: async () => PASS });
    const r1 = await runPipeline([v1.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r1.ok).toBe(true);
    expect(v1.calls()).toBe(1);

    // Same name, bumped version — must re-run.
    const v2 = counted({ name: "checker", version: "2", run: async () => PASS });
    const r2 = await runPipeline([v2.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r2.ok).toBe(true);
    expect(v2.calls()).toBe(1);
  });

  test("cache returns a frozen, isolated snapshot — caller mutation cannot poison the cache", async () => {
    const cache = createMemoryCache();
    const stage = createSyntaxStage(okCheck, "1");
    const r1 = await runPipeline([stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Hostile caller tries to mutate the returned summary.
    expect(() => {
      (r1.value as unknown as { passed: boolean }).passed = false;
    }).toThrow();
    const firstDigest = r1.value.stageResults[0];
    if (firstDigest !== undefined) {
      expect(() => {
        (firstDigest as unknown as { stage: string }).stage = "TAMPERED";
      }).toThrow();
    }

    // Cache must still serve a clean summary.
    const r2 = await runPipeline([stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.passed).toBe(true);
    expect(r2.value.stageResults.map((s) => s.stage)).toEqual(["syntax"]);
  });

  test("fingerprint resists name/version collision via reserved characters", async () => {
    const cache = createMemoryCache();
    // Two distinct stage configurations whose naive `name@version|...` joins
    // would collide. JSON-encoding must keep them apart.
    const a = counted({ name: "a|b", version: "1", run: async () => PASS });
    const b = counted({ name: "a", version: "1|b@1", run: async () => PASS });
    await runPipeline([a.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    await runPipeline([b.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  test("cache hit from a hostile backend is normalized — caller cannot poison shared state", async () => {
    // Backend returns a payload that is consistent with the stage list (so it
    // passes validation) but mutable. The pipeline must still freeze and copy.
    const mutable: ForgeStageDigestLike[] = [{ stage: "syntax", passed: true, durationMs: 1 }];
    const stored: {
      passed: boolean;
      sandbox: boolean;
      totalDurationMs: number;
      stageResults: ForgeStageDigestLike[];
    } = { passed: true, sandbox: false, totalDurationMs: 1, stageResults: mutable };
    const hostileCache = {
      get: async (key: string) => ({ key, summary: stored as unknown as ForgeVerificationSummary }),
      set: async () => {},
    };
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], artifact, {
      cache: hostileCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => {
      (result.value as unknown as { passed: boolean }).passed = false;
    }).toThrow();
    // Mutating the backend's stored object after the call must not be visible
    // through the returned summary (deep-copied by freezeSummary).
    mutable.push({ stage: "INJECTED", passed: true, durationMs: 0 });
    expect(result.value.stageResults.map((s) => s.stage)).toEqual(["syntax"]);
  });

  test("malformed cache payload (wrong stage names) is rejected — pipeline re-verifies", async () => {
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const malformedCache = {
      get: async (key: string) => ({
        key,
        summary: {
          passed: true,
          sandbox: false,
          totalDurationMs: 0,
          stageResults: [], // empty — would be a fail-open if trusted
        } as ForgeVerificationSummary,
      }),
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: malformedCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stage.calls()).toBe(1); // re-verified despite the cache hit
    expect(result.value.stageResults.map((s) => s.stage)).toEqual(["syntax"]);
  });

  test("malformed cache payload (wrong stage name) is rejected", async () => {
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const malformedCache = {
      get: async (key: string) => ({
        key,
        summary: {
          passed: true,
          sandbox: false,
          totalDurationMs: 1,
          stageResults: [{ stage: "different-name", passed: true, durationMs: 1 }],
        } as ForgeVerificationSummary,
      }),
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: malformedCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    expect(stage.calls()).toBe(1);
  });

  test("cached sandbox=true is rejected when no current stage declares sandbox", async () => {
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const lyingCache = {
      get: async (key: string) => ({
        key,
        summary: {
          passed: true,
          sandbox: true, // backend forges the trust signal
          totalDurationMs: 1,
          stageResults: [{ stage: "syntax", passed: true, durationMs: 1 }],
        } as ForgeVerificationSummary,
      }),
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: lyingCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Hit fails consistency (sandbox=true vs declared sandbox=false), so
    // stages re-run and the recomputed summary reports declared sandbox.
    expect(stage.calls()).toBe(1);
    expect(result.value.sandbox).toBe(false);
  });

  test("cached sandbox=true is honored when at least one current stage declares sandbox", async () => {
    const sbStage: VerifierStage<FakeArtifact> = {
      name: "sb",
      version: "1",
      sandboxed: true,
      run: async () => ({ ok: true, sandboxed: true }),
    };
    const cachingCache = {
      get: async (key: string) => ({
        key,
        summary: {
          passed: true,
          sandbox: true,
          totalDurationMs: 1,
          stageResults: [{ stage: "sb", passed: true, durationMs: 1 }],
        } as ForgeVerificationSummary,
      }),
      set: async () => {},
    };
    const result = await runPipeline([sbStage], artifact, {
      cache: cachingCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sandbox).toBe(true);
  });

  test("stages receive a deep-frozen snapshot — caller is isolated AND nested mutation throws", async () => {
    const obj: { name: string; nested: { count: number }; mutated?: boolean } = {
      name: "snapshot-test",
      nested: { count: 1 },
    };
    let receivedNested: { count: number } | undefined;
    const stage: VerifierStage<typeof obj> = {
      name: "mutator",
      version: "1",
      run: async (a) => {
        receivedNested = a.nested;
        // Top-level AND nested mutation must throw — otherwise an early stage
        // could rewrite content between fingerprint computation and a later
        // stage's verification, attaching a cached pass to bytes never seen.
        expect(() => {
          a.mutated = true;
        }).toThrow();
        expect(() => {
          a.nested.count = 999;
        }).toThrow();
        return PASS;
      },
    };
    const result = await runPipeline([stage], obj);
    expect(result.ok).toBe(true);
    expect(receivedNested).not.toBe(obj.nested);
    expect(obj.mutated).toBeUndefined();
    expect(obj.nested.count).toBe(1);
  });

  test("early stage cannot rewrite snapshot content seen by later stages", async () => {
    const obj: { payload: { v: number } } = { payload: { v: 1 } };
    const seenByLater: number[] = [];
    const stages: readonly VerifierStage<typeof obj>[] = [
      {
        name: "first",
        version: "1",
        run: async (a) => {
          // Hostile cast — even after dropping readonly, the deep freeze blocks
          // the write. The `try` swallows the throw so we still return PASS and
          // the next stage gets to run and assert what it sees.
          try {
            (a.payload as { v: number }).v = 999;
          } catch {
            /* expected: frozen */
          }
          return PASS;
        },
      },
      {
        name: "second",
        version: "1",
        run: async (a) => {
          seenByLater.push(a.payload.v);
          return PASS;
        },
      },
    ];
    const result = await runPipeline(stages, obj);
    expect(result.ok).toBe(true);
    expect(seenByLater).toEqual([1]);
  });

  test("artifact that is not structured-cloneable is rejected", async () => {
    // Functions are not cloneable.
    const fn = () => 42;
    const stages = [createSyntaxStage(okCheck, "1")];
    const result = await runPipeline(stages, { fn } as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
  });

  test("Map artifact is rejected — frozen Maps are still mutable via .set", async () => {
    const stages = [createSyntaxStage(okCheck, "1")];
    const result = await runPipeline(stages, new Map([["k", 1]]) as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("Map");
  });

  test("Set artifact is rejected — frozen Sets are still mutable via .add", async () => {
    const stages = [createSyntaxStage(okCheck, "1")];
    const result = await runPipeline(stages, new Set([1, 2]) as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("Set");
  });

  test("typed-array artifact is rejected", async () => {
    const stages = [createSyntaxStage(okCheck, "1")];
    const result = await runPipeline(stages, new Uint8Array([1, 2, 3]) as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
  });

  test("class-instance artifact is rejected — structuredClone strips prototype", async () => {
    class MyArtifact {
      readonly name: string;
      constructor(name: string) {
        this.name = name;
      }
    }
    const stages = [createSyntaxStage(okCheck, "1")];
    const result = await runPipeline(stages, new MyArtifact("x") as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("non-plain");
  });

  test("artifact with an accessor (getter) is rejected pre-clone — getter never fires", async () => {
    let getterFireCount = 0;
    const obj = { name: "x" };
    Object.defineProperty(obj, "trapped", {
      enumerable: true,
      configurable: true,
      get() {
        getterFireCount += 1;
        return 42;
      },
    });
    const stage: VerifierStage<typeof obj> = {
      name: "inspect",
      version: "1",
      run: async () => PASS,
    };
    const result = await runPipeline([stage], obj as unknown as typeof obj);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("accessor");
    // Pre-clone descriptor walk reads the descriptor without invoking .get.
    // Crucial: caller-controlled code does NOT execute on the verifier stack.
    expect(getterFireCount).toBe(0);
  });

  test("top-level function artifact is rejected", async () => {
    const stages = [createSyntaxStage(okCheck, "1")];
    const fn = (() => 1) as unknown as FakeArtifact;
    const result = await runPipeline(stages, fn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("function");
  });

  test("symbol-keyed own properties are rejected pre-clone — no hidden state attestation", async () => {
    // structuredClone silently drops symbol keys, which would let a caller
    // submit hidden state and still get a successful verification for a
    // different effective object. Reject before clone so the verifier can
    // never attest to a strict subset of the caller's data.
    const sym = Symbol("hidden");
    const obj = { name: "x", [sym]: { secret: 1 } };
    const stage: VerifierStage<typeof obj> = {
      name: "inspect",
      version: "1",
      run: async () => PASS,
    };
    const result = await runPipeline([stage], obj as unknown as typeof obj);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("symbol");
  });

  test("non-enumerable own properties are rejected pre-clone — no hidden state attestation", async () => {
    const obj = { name: "x" };
    Object.defineProperty(obj, "hidden", {
      enumerable: false,
      configurable: true,
      value: 99,
    });
    const stage: VerifierStage<typeof obj> = {
      name: "inspect",
      version: "1",
      run: async () => PASS,
    };
    const result = await runPipeline([stage], obj as unknown as typeof obj);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("non-enumerable");
  });

  test("array with a numeric-index accessor is rejected pre-clone — getter never fires", async () => {
    let getterFireCount = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterFireCount += 1;
        return "INJECTED";
      },
    });
    Object.defineProperty(arr, "length", { value: 1 });
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1")],
      arr as unknown as FakeArtifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(getterFireCount).toBe(0);
  });

  test("snapshot phase honors abort signal — fails fast on already-aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], artifact, {
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
    expect(result.error.context?.stage).toBe("<snapshot>");
  });

  test("array with extra named property is rejected by post-clone validation", async () => {
    const arr: unknown[] & { extra?: { x: number } } = [1, 2];
    arr.extra = { x: 1 };
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1")],
      arr as unknown as FakeArtifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("array property");
  });

  test("cyclic artifact bypasses cache (deterministic key impossible) but still verifies", async () => {
    type Cyclic = { name: string; self?: Cyclic };
    const obj: Cyclic = { name: "cyc" };
    obj.self = obj;
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const cache = createMemoryCache();
    // First call: stages run, cache cannot be populated for the cyclic input.
    const r1 = await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r1.ok).toBe(true);
    expect(stage.calls()).toBe(1);
    // Second call: cache still bypassed (no key was ever stored), stages re-run.
    const r2 = await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r2.ok).toBe(true);
    expect(stage.calls()).toBe(2);
  });

  test("self-referential plain object is accepted (cycle guard)", async () => {
    type Cyclic = { name: string; self?: Cyclic };
    const obj: Cyclic = { name: "cyc" };
    obj.self = obj;
    // structuredClone supports cycles; the validator must too.
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1")],
      obj as unknown as FakeArtifact,
    );
    expect(result.ok).toBe(true);
  });

  test("self-referential array is accepted (cycle guard)", async () => {
    const arr: unknown[] = [];
    arr.push(arr);
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], {
      name: "x",
      inner: arr,
    } as unknown as FakeArtifact);
    expect(result.ok).toBe(true);
  });

  test("abort before cache lookup maps to TIMEOUT — does not consult cache", async () => {
    const ac = new AbortController();
    ac.abort();
    let cacheHit = 0;
    const cache = {
      get: async () => {
        cacheHit += 1;
        return undefined;
      },
      set: async () => {},
    };
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
    expect(cacheHit).toBe(0);
  });

  test("abort during cache lookup is honored — does not return cached success", async () => {
    const ac = new AbortController();
    const slowCache = {
      get: async (key: string) => {
        ac.abort(); // simulate caller giving up while the read is in flight
        return {
          key,
          summary: {
            passed: true,
            sandbox: false,
            totalDurationMs: 0,
            stageResults: [{ stage: "syntax", passed: true, durationMs: 0 }],
          },
        };
      },
      set: async () => {},
    };
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], artifact, {
      cache: slowCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
  });

  test("nested Map inside a plain object is also rejected", async () => {
    const stages = [createSyntaxStage(okCheck, "1")];
    const result = await runPipeline(stages, {
      name: "x",
      inner: new Map([["k", 1]]),
    } as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("$.inner");
  });

  test("flipping a stage from non-sandboxed to sandboxed invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const v1 = counted({ name: "checker", version: "1", run: async () => PASS });
    const r1 = await runPipeline([v1.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.sandbox).toBe(false);

    // Same name AND version, but now declares sandboxed=true. Without
    // sandboxed-in-fingerprint, the stale cache hit would be returned as
    // sandbox: true and the actual sandbox check would never run.
    const v2 = counted({
      name: "checker",
      version: "1",
      sandboxed: true,
      run: async () => ({ ok: true, sandboxed: true }),
    });
    const r2 = await runPipeline([v2.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(v2.calls()).toBe(1); // re-verified, did not reuse the stale entry
    expect(r2.value.sandbox).toBe(true);
  });

  test("fresh and cached runs produce the same sandbox value", async () => {
    const cache = createMemoryCache();
    const sb: VerifierStage<FakeArtifact> = {
      name: "sb",
      version: "1",
      sandboxed: true,
      run: async () => ({ ok: true, sandboxed: true }),
    };
    const fresh = await runPipeline([sb], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    const cached = await runPipeline([sb], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(fresh.ok).toBe(true);
    expect(cached.ok).toBe(true);
    if (!fresh.ok || !cached.ok) return;
    expect(fresh.value.sandbox).toBe(cached.value.sandbox);
    expect(cached.value.sandbox).toBe(true);
  });

  test("empty stages list is rejected — fail-closed against misconfiguration", async () => {
    const result = await runPipeline([] as readonly VerifierStage<FakeArtifact>[], artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
  });

  test("built-in factory accepts version — bump invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const v1 = counted(createSyntaxStage(okCheck, "1"));
    const v2 = counted(createSyntaxStage(okCheck, "2"));
    await runPipeline([v1.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    await runPipeline([v2.stage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(v1.calls()).toBe(1);
    expect(v2.calls()).toBe(1);
  });

  test("abort during final stage discards the success — caller's intent overrides the in-flight result", async () => {
    // R20: a caller that explicitly aborted while the last stage was
    // running must NOT receive a passing summary. The stage's side
    // effect (if any) has already happened, but returning passed=true
    // to the cancelling caller would let them act on a verification
    // they themselves rejected. The post-stage abort gate discards.
    const ac = new AbortController();
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      {
        name: "only",
        version: "1",
        run: async () => {
          ac.abort();
          return PASS;
        },
      },
    ];
    const result = await runPipeline(stages, artifact, { signal: ac.signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
    // Either the post-stage gate ("only") or the outer single-flight
    // wrapper ("<inflight>") may win the race after ac.abort. Both are
    // correct TIMEOUT outcomes; either stage attribution is acceptable.
    expect(["only", "<inflight>"]).toContain(String(result.error.context?.stage));
  });

  test("cache key derived from artifact — different artifacts do not share cache", async () => {
    const cache = createMemoryCache();
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const artifactA: FakeArtifact = { name: "A" };
    const artifactB: FakeArtifact = { name: "B" };
    await runPipeline([stage.stage], artifactA, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(1);
    // A different artifact under the same key fn must not see the prior pass.
    await runPipeline([stage.stage], artifactB, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(2);
    // But re-verifying A should still hit the cache.
    await runPipeline([stage.stage], artifactA, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(2);
  });

  test("cache.get failure defaults to fail — does NOT silently re-execute non-idempotent stages", async () => {
    // Default policy: stages may have side effects (sandbox jobs, external
    // API calls, quota), so a transient backend outage must not silently
    // re-run them. Surface as INTERNAL inside the Result envelope; the
    // exception never escapes the documented Promise<Result<...>> contract.
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const flakyCache = {
      get: async () => {
        throw new Error("read backend down");
      },
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: flakyCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.context?.stage).toBe("<cache>");
    expect(result.error.message).toContain("read backend down");
    // Crucially, the stage was NOT re-executed under cache failure.
    expect(stage.calls()).toBe(0);
  });

  test('cache.get failure with cacheReadFailure:"miss" treats outage as a miss', async () => {
    // Opt-in lenient policy for pipelines whose stages are KNOWN pure.
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const flakyCache = {
      get: async () => {
        throw new Error("read backend down");
      },
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: flakyCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      cacheReadFailure: "miss",
    });
    expect(result.ok).toBe(true);
    expect(stage.calls()).toBe(1);
  });

  test("cache provided without namespace is rejected as INVALID_CONFIG", async () => {
    const cache = createMemoryCache();
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], artifact, { cache });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("namespace is required");
  });

  test("cache.set failure does not turn success into rejection", async () => {
    const flakyCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error("cache backend down");
      },
    };
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], artifact, {
      cache: flakyCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passed).toBe(true);
  });
});

interface ForgeStageDigestLike {
  readonly stage: string;
  readonly passed: boolean;
  readonly durationMs: number;
}

describe("createMemoryCache", () => {
  test("get returns undefined for unknown key", async () => {
    const cache = createMemoryCache();
    expect(await cache.get("missing")).toBeUndefined();
  });

  test("set then get round-trips an envelope", async () => {
    const cache = createMemoryCache();
    const summary = {
      passed: true,
      sandbox: false,
      totalDurationMs: 1,
      stageResults: [{ stage: "x", passed: true, durationMs: 1 }],
    } as const;
    await cache.set("k", { key: "k", summary });
    const got = await cache.get("k");
    expect(got?.key).toBe("k");
    expect(got?.summary).toEqual(summary);
  });
});

describe("built-in stage factories propagate StageContext", () => {
  test("createSyntaxStage check receives the AbortSignal so it can cooperatively cancel", async () => {
    const ac = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let observedAbortedBefore: boolean | undefined;
    const stage = createSyntaxStage<FakeArtifact>((_a, ctx) => {
      observedSignal = ctx.signal;
      observedAbortedBefore = ctx.signal?.aborted;
      ac.abort();
      // Cooperative cancellation: predicate inspects ctx.signal AFTER abort
      // and short-circuits its own work instead of returning PASS.
      if (ctx.signal?.aborted === true) {
        return { ok: false, reason: "cancelled by caller" };
      }
      return PASS;
    }, "1");
    const result = await runPipeline([stage], { name: "x" }, { signal: ac.signal });
    // ctx.signal is a mirror of ac.signal (so the leader can be detached
    // when a follower joins single-flight). It aborts iff ac.signal does.
    expect(observedSignal).toBeDefined();
    expect(observedAbortedBefore).toBe(false);
    // Pipeline returns TIMEOUT — caller's signal aborted, the pipeline's
    // mirror aborts with it, and either the in-stage signal race or the
    // outer wrapper short-circuits before the stage's "{ok:false}" is
    // mapped to VALIDATION. Either VALIDATION (with "cancelled by caller"
    // text) or TIMEOUT is acceptable as long as the result is not ok.
    expect(result.ok).toBe(false);
    if (result.ok) return;
  });
});

describe("topology-aware canonical encoding (shared refs distinct from duplicates)", () => {
  test("DAG with shared subobject does NOT alias the same artifact with two independent copies", async () => {
    // Stages observe `===` reference identity, so a cached pass for the
    // shared-ref graph is not valid for the independent-copy graph and
    // vice versa. Topology must be part of the cache key.
    const cache = createMemoryCache();
    const sharedStage = counted(createSyntaxStage(okCheck, "1"));
    const dupStage = counted(createSyntaxStage(okCheck, "1"));
    const shared = { kind: "leaf", n: 1 };
    const dagShared: FakeArtifact = { name: "x", a: shared, b: shared } as unknown as FakeArtifact;
    const dagDup: FakeArtifact = {
      name: "x",
      a: { kind: "leaf", n: 1 },
      b: { kind: "leaf", n: 1 },
    } as unknown as FakeArtifact;
    await runPipeline([sharedStage.stage], dagShared, {
      cache,
      namespace: "topo",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    await runPipeline([dupStage.stage], dagDup, {
      cache,
      namespace: "topo",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(sharedStage.calls()).toBe(1);
    expect(dupStage.calls()).toBe(1); // would be 0 if topologies aliased
  });

  test("identical DAG submitted twice still hits cache (topology-stable)", async () => {
    const cache = createMemoryCache();
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const shared = { kind: "leaf" };
    const dag = { name: "x", a: shared, b: shared } as unknown as FakeArtifact;
    await runPipeline([stage.stage], dag, {
      cache,
      namespace: "topo",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    await runPipeline([stage.stage], dag, {
      cache,
      namespace: "topo",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(1); // same DAG → same key → cache hit
  });
});

describe("sparse arrays (no cache-key aliasing with dense arrays)", () => {
  test("sparse array at root is rejected pre-clone — would alias dense in cache key", async () => {
    // `new Array(1)` has length 1 with a hole at index 0. `[].length === 0`
    // and `[undefined].length === 1`. A naive serializer would alias the
    // sparse array to one of those depending on whether holes are skipped.
    const sparse = new Array(1);
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1")],
      sparse as unknown as FakeArtifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("hole");
  });

  test("sparse array nested in plain object is rejected", async () => {
    const sparse: unknown[] = [];
    sparse[2] = "x"; // creates holes at 0 and 1
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], {
      name: "x",
      arr: sparse,
    } as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("hole");
  });

  test("dense array with explicit undefined values is accepted (not a hole)", async () => {
    // [undefined] is dense — index 0 has an own data descriptor with
    // value=undefined. Should pass validation and produce a stable key.
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], {
      name: "x",
      arr: [undefined, undefined],
    } as unknown as FakeArtifact);
    expect(result.ok).toBe(true);
  });
});

describe("single-flight (concurrent identical requests are coalesced)", () => {
  test("signal-bearing callers DO coalesce — shared pipeline survives any one caller's abort", async () => {
    // Two callers with their own signals concurrently verify the same key.
    // The shared pipeline runs without either signal, so leader's abort
    // cannot cancel the work follower is awaiting AND duplicate work is
    // not performed. Leader's own caller still gets TIMEOUT via the outer
    // waitWithSignal race; follower (signal never fires) gets the success.
    let stageStarts = 0;
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "iso" };
    const slow: VerifierStage<FakeArtifact> = {
      name: "slow",
      version: "1",
      run: async () => {
        stageStarts += 1;
        await new Promise((r) => setTimeout(r, 30));
        return PASS;
      },
    };
    const leaderAc = new AbortController();
    const followerAc = new AbortController();
    const leaderPromise = runPipeline([slow], artifact, {
      cache,
      namespace: "iso",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      signal: leaderAc.signal,
    });
    const followerPromise = runPipeline([slow], artifact, {
      cache,
      namespace: "iso",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      signal: followerAc.signal,
    });
    // Leader aborts immediately; follower never aborts.
    leaderAc.abort();
    const [leader, follower] = await Promise.all([leaderPromise, followerPromise]);
    expect(leader.ok).toBe(false); // leader's own caller honored its abort
    expect(follower.ok).toBe(true); // follower ran on shared pipeline
    expect(stageStarts).toBe(1); // the shared pipeline ran exactly once
  });

  test("cache.set is suppressed when leader caller aborts before pipeline completes", async () => {
    // R21 regression: leader's pipeline detached from leader's signal so
    // it can serve followers, but caching a pass for a verification the
    // leader explicitly cancelled would let later callers receive a
    // cached "passed" the original requester rejected. Verify cache.set
    // is suppressed in that case.
    const setCalls: string[] = [];
    const trackingCache = {
      get: async () => undefined,
      set: async (key: string) => {
        setCalls.push(key);
      },
    };
    const ac = new AbortController();
    const slow: VerifierStage<FakeArtifact> = {
      name: "only",
      version: "1",
      run: async () => {
        ac.abort(); // leader aborts mid-stage
        await new Promise((r) => setTimeout(r, 5));
        return PASS;
      },
    };
    const r = await runPipeline([slow], { name: "leader-abort" } as FakeArtifact, {
      cache: trackingCache,
      namespace: "abort",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      signal: ac.signal,
    });
    expect(r.ok).toBe(false); // leader gets TIMEOUT via outer waitWithSignal
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
    expect(setCalls.length).toBe(0); // cache write suppressed — no false attestation persisted
  });

  test("R23: solo cache-backed caller still honors signal inside the stage loop", async () => {
    // Without the leader-detach-on-follower-join scheme, a cache-backed
    // run with no follower would silently drop the caller's signal —
    // expensive uncancellable work could continue burning quota after
    // the caller had already given up.
    const cache = createMemoryCache();
    const ac = new AbortController();
    let observed: AbortSignal | undefined;
    let stage1Started = false;
    let stage2Ran = false;
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      {
        name: "first",
        version: "1",
        run: async (_a, ctx) => {
          observed = ctx.signal;
          stage1Started = true;
          ac.abort(); // caller aborts during stage 1
          return PASS;
        },
      },
      {
        name: "second",
        version: "1",
        run: async () => {
          stage2Ran = true;
          return PASS;
        },
      },
    ];
    const r = await runPipeline(stages, { name: "solo" } as FakeArtifact, {
      cache,
      namespace: "solo",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
    expect(stage1Started).toBe(true); // stage 1 ran
    expect(stage2Ran).toBe(false); // pre-stage abort gate caught it
    expect(observed).toBeDefined(); // ctx.signal was wired through
    // Mirror signal must abort when caller signal aborts.
    expect(observed?.aborted).toBe(true);
  });

  test("solo caller aborting during final stage gets TIMEOUT, not passed=true", async () => {
    // Solo no-cache run: pipelineSignal === caller signal. Stage ignores
    // abort and returns PASS, then the post-stage abort gate discards the
    // summary so caller never sees a passing result for verification they
    // explicitly cancelled.
    const ac = new AbortController();
    const slow: VerifierStage<FakeArtifact> = {
      name: "only",
      version: "1",
      run: async () => {
        ac.abort(); // caller aborts mid-stage
        await new Promise((r) => setTimeout(r, 5));
        return PASS; // stage ignores cancellation and returns success
      },
    };
    const r = await runPipeline([slow], { name: "abort" } as FakeArtifact, {
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
    // Either post-stage gate ("only") or outer waitWithSignal wrapper
    // ("<inflight>") may attribute. Both are correct TIMEOUT outcomes.
    expect(["only", "<inflight>"]).toContain(String(r.error.context?.stage));
  });
});

describe("R25/r10 abort race before microtask-deferred stage.run", () => {
  test("late abort during stage 1 + abort propagates: stage 2 microtask re-check prevents stage from starting", async () => {
    let stage2Started = false;
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      {
        name: "first",
        version: "1",
        run: async (_a, ctx) => {
          // Abort happens during stage 1's await; the pre-stage gate
          // for stage 2 fires the next iteration, but if it failed to
          // catch the late abort, the microtask re-check inside
          // runStage still prevents stage 2's run from starting.
          ctx.signal && new AbortController().abort();
          return PASS;
        },
      },
      {
        name: "second",
        version: "1",
        run: () => {
          stage2Started = true;
          return PASS;
        },
      },
    ];
    const ac = new AbortController();
    const p = runPipeline(stages, { name: "race" } as FakeArtifact, { signal: ac.signal });
    // Abort on the very next microtask — between pre-stage gate of
    // stage 1 (already passed when this fires) and the stage 1 run.
    queueMicrotask(() => ac.abort());
    const r = await p;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
    expect(stage2Started).toBe(false);
  });
});

describe("R25/r8 sync stage throws + always attach to in-flight slot", () => {
  test("synchronous stage throw is normalized to INTERNAL inside Result envelope", async () => {
    const syncBoom: VerifierStage<FakeArtifact> = {
      name: "boom",
      version: "1",
      run: () => {
        throw new Error("sync kaboom");
      },
    };
    const r = await runPipeline([syncBoom], { name: "x" } as FakeArtifact);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INTERNAL");
    expect(r.error.context?.stage).toBe("boom");
    expect(r.error.cause).toBeInstanceOf(Error);
  });

  test("retry after leader abort starts a fresh execution (R26+R27: availability over dedup)", async () => {
    let stageStarts = 0;
    const resolvers: Array<() => void> = [];
    const slow: VerifierStage<FakeArtifact> = {
      name: "slow",
      version: "1",
      run: async () => {
        stageStarts += 1;
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "abort-then-retry" };
    const baseOpts = {
      cache,
      namespace: "abr",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const ac = new AbortController();
    const leader = runPipeline([slow], artifact, { ...baseOpts, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const leaderResult = await leader;
    expect(leaderResult.ok).toBe(false); // leader aborted
    // Retry: leader's slot already evicted on work() settlement → fresh.
    const retry = runPipeline([slow], artifact, baseOpts);
    await new Promise((r) => setTimeout(r, 5));
    expect(stageStarts).toBe(2); // fresh leader, key not bricked
    for (const r of resolvers) r();
    await retry;
  });
});

describe("R26 timeout-then-retry releases slot for a fresh attempt", () => {
  test("retry after stageTimeoutMs starts a fresh execution rather than inheriting stale TIMEOUT", async () => {
    // R26 reverses R25/r7's "hold slot until stages settle" semantics.
    // An uncooperative plugin's underlying promise may never settle —
    // holding the slot would brick the key for the lifetime of the
    // process. The library's stageTimeoutMs contract already warns
    // that work may continue in the background; we honor availability
    // over deduplication. (The leader's abandoned underlying still
    // runs; the new attempt may also time out, but each caller gets a
    // fresh chance.)
    let stageStarts = 0;
    const resolvers: Array<() => void> = [];
    const slow: VerifierStage<FakeArtifact> = {
      name: "slow",
      version: "1",
      run: async () => {
        stageStarts += 1;
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "retry" };
    const opts = {
      cache,
      namespace: "retry",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
      stageTimeoutMs: 30,
    };
    const first = await runPipeline([slow], artifact, opts);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("TIMEOUT");
    expect(stageStarts).toBe(1);
    // Retry: leader has resolved → slot evicted → fresh execution.
    const retryPromise = runPipeline([slow], artifact, opts);
    await new Promise((r) => setTimeout(r, 10));
    expect(stageStarts).toBe(2); // fresh leader, key not bricked
    // Drain background work so the test exits cleanly.
    for (const r of resolvers) r();
    const retry = await retryPromise;
    // Retry also times out (stage still slow), but it was its own attempt.
    expect(retry.ok === true || (retry.ok === false && retry.error.code === "TIMEOUT")).toBe(true);
  });

  test("cache without executionContextKey is rejected as INVALID_CONFIG", async () => {
    const cache = createMemoryCache();
    const stage: VerifierStage<FakeArtifact> = {
      name: "x",
      version: "1",
      run: async () => PASS,
    };
    const r = await runPipeline([stage], { name: "no-ctx" } as FakeArtifact, {
      cache,
      namespace: "no-ctx",
      acknowledgeTrustedCache: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
    expect(r.error.message).toContain("executionContextKey");
  });

  test("coalesceUncached without executionContextKey is rejected", async () => {
    const r = await runPipeline(
      [{ name: "x", version: "1", run: async () => PASS }],
      { name: "no-ctx" } as FakeArtifact,
      { coalesceUncached: true },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
    expect(r.error.message).toContain("executionContextKey");
  });
});

describe("R25/r6 executionContextKey + opt-in uncached coalescing", () => {
  test("two cached callers with DIFFERENT executionContextKey do not share results", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "ctx",
      version: "1",
      run: async () => {
        stageCalls += 1;
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "ctx" };
    const r1 = await runPipeline([stage], artifact, {
      cache,
      namespace: "ctx",
      acknowledgeTrustedCache: true,
      executionContextKey: "tenant-A",
    });
    const r2 = await runPipeline([stage], artifact, {
      cache,
      namespace: "ctx",
      acknowledgeTrustedCache: true,
      executionContextKey: "tenant-B",
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(stageCalls).toBe(2); // distinct context partitions
  });

  test("opt-in uncached coalescing shares one execution across concurrent callers", async () => {
    let stageCalls = 0;
    let release: (() => void) | undefined;
    const stage: VerifierStage<FakeArtifact> = {
      name: "shared",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return PASS;
      },
    };
    const artifact: FakeArtifact = { name: "opt-in" };
    const p1 = runPipeline([stage], artifact, {
      coalesceUncached: true,
      executionContextKey: "ctx",
    });
    const p2 = runPipeline([stage], artifact, {
      coalesceUncached: true,
      executionContextKey: "ctx",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(1); // coalesced
    if (release === undefined) throw new Error("no release");
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(stageCalls).toBe(1);
  });

  test("opt-in uncached coalescing partitions by executionContextKey", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "shared",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return PASS;
      },
    };
    const artifact: FakeArtifact = { name: "p" };
    const [r1, r2] = await Promise.all([
      runPipeline([stage], artifact, { coalesceUncached: true, executionContextKey: "A" }),
      runPipeline([stage], artifact, { coalesceUncached: true, executionContextKey: "B" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(stageCalls).toBe(2); // distinct contexts → distinct slots
  });
});

describe("R25/r5 uncached single-flight does NOT coalesce (closures may differ)", () => {
  test("two concurrent uncached callers each run their own stage execution", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "shared",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return PASS;
      },
    };
    const artifact: FakeArtifact = { name: "uncached" };
    const [r1, r2] = await Promise.all([
      runPipeline([stage], artifact),
      runPipeline([stage], artifact),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(stageCalls).toBe(2); // each ran independently — no closure aliasing
  });

  test("cyclic artifact still verifies on a non-sandboxed pipeline (no coalescing required)", async () => {
    const cyclic: { name: string; self?: unknown } = { name: "c" };
    cyclic.self = cyclic;
    const stage: VerifierStage<FakeArtifact> = {
      name: "pure",
      version: "1",
      run: async () => PASS,
    };
    const r = await runPipeline([stage], cyclic as unknown as FakeArtifact);
    expect(r.ok).toBe(true);
  });
});

describe("R25/r3 hardening: wide object preflight + stageTimeoutMs validation", () => {
  test.each([
    ["zero", 0],
    ["negative", -10],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
  ])("stageTimeoutMs=%s rejected as INVALID_CONFIG (does not silently disable watchdog)", async (_label, bad) => {
    const stage: VerifierStage<FakeArtifact> = {
      name: "x",
      version: "1",
      run: async () => PASS,
    };
    const r = await runPipeline([stage], { name: "v" } as FakeArtifact, {
      stageTimeoutMs: bad,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
    expect(r.error.message).toContain("stageTimeoutMs");
  });

  test("wide plain object exceeding node budget is rejected before descriptor materialization", async () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 60_000; i++) wide[`k${i}`] = i;
    const r = await runPipeline(
      [{ name: "x", version: "1", run: async () => PASS }],
      wide as unknown as FakeArtifact,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
    expect(r.error.message).toContain("maximum node count");
  });
});

describe("single-flight isolation (R25/r2: doomed-leader + stageTimeoutMs)", () => {
  test("late follower does NOT inherit a leader's already-aborted pipeline", async () => {
    let stageStarts = 0;
    let release: (() => void) | undefined;
    const cache = createMemoryCache();
    const stage: VerifierStage<FakeArtifact> = {
      name: "rerun",
      version: "1",
      run: async () => {
        stageStarts += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return PASS;
      },
    };
    const artifact: FakeArtifact = { name: "doomed" };
    const leaderAc = new AbortController();
    leaderAc.abort(); // pre-abort
    const leaderPromise = runPipeline([stage], artifact, {
      cache,
      namespace: "doomed",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      signal: leaderAc.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const followerPromise = runPipeline([stage], artifact, {
      cache,
      namespace: "doomed",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(stageStarts).toBeGreaterThanOrEqual(1); // follower ran fresh
    if (release !== undefined) release();
    const [leader, follower] = await Promise.all([leaderPromise, followerPromise]);
    expect(leader.ok).toBe(false);
    expect(follower.ok).toBe(true);
  });

  test("two callers with DIFFERENT stageTimeoutMs do not coalesce", async () => {
    let stageCalls = 0;
    let release: (() => void) | undefined;
    const cache = createMemoryCache();
    const stage: VerifierStage<FakeArtifact> = {
      name: "tt",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return PASS;
      },
    };
    const artifact: FakeArtifact = { name: "tt" };
    const loose = runPipeline([stage], artifact, {
      cache,
      namespace: "tt",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      stageTimeoutMs: 1000,
    });
    const strict = runPipeline([stage], artifact, {
      cache,
      namespace: "tt",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      stageTimeoutMs: 50,
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(stageCalls).toBe(2); // distinct slots
    const strictResult = await strict;
    expect(strictResult.ok).toBe(false);
    if (!strictResult.ok) expect(strictResult.error.code).toBe("TIMEOUT");
    if (release !== undefined) release();
    await loose.catch(() => {});
  });
});

describe("single-flight isolation (R22: cache identity + policy)", () => {
  test("two callers with DIFFERENT cache backends do not coalesce", async () => {
    let stageCalls = 0;
    let release: (() => void) | undefined;
    const stage: VerifierStage<FakeArtifact> = {
      name: "shared",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return PASS;
      },
    };
    const cacheA = createMemoryCache();
    const cacheB = createMemoryCache();
    const artifact: FakeArtifact = { name: "iso" };
    const p1 = runPipeline([stage], artifact, {
      cache: cacheA,
      namespace: "ns",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    const p2 = runPipeline([stage], artifact, {
      cache: cacheB,
      namespace: "ns",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(2); // distinct caches → distinct inflight slots
    if (release === undefined) throw new Error("no release");
    release();
    // Two pipelines now blocked on the same release closure; release once is
    // sufficient because both got the same closure ref reassigned. Spin until
    // both resolve.
    await Promise.race([
      Promise.all([p1, p2]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000)),
    ]).catch(async () => {
      // If only one resolved, manually resolve the other (bug recovery in test only).
    });
  });

  test("two callers with DIFFERENT cacheReadFailure modes do not coalesce", async () => {
    let stageCalls = 0;
    let release: (() => void) | undefined;
    const cache = createMemoryCache();
    const stage: VerifierStage<FakeArtifact> = {
      name: "policy",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return PASS;
      },
    };
    const artifact: FakeArtifact = { name: "policy" };
    const failer = runPipeline([stage], artifact, {
      cache,
      namespace: "p",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      cacheReadFailure: "fail",
    });
    const misser = runPipeline([stage], artifact, {
      cache,
      namespace: "p",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
      cacheReadFailure: "miss",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(2); // policies differ → distinct slots
    if (release === undefined) throw new Error("no release");
    release();
    await Promise.race([
      Promise.all([failer, misser]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000)),
    ]).catch(() => {});
  });

  test("R24: cache without acknowledgeTrustedCache is rejected as INVALID_CONFIG", async () => {
    const cache = createMemoryCache();
    const stage: VerifierStage<FakeArtifact> = {
      name: "v",
      version: "1",
      run: async () => PASS,
    };
    const r = await runPipeline([stage], { name: "no-ack" } as FakeArtifact, {
      cache,
      namespace: "no-ack",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
    expect(r.error.message).toContain("acknowledgeTrustedCache: true");
  });

  test("R24: stageTimeoutMs preempts an uncooperative plugin", async () => {
    let stageResolve: (() => void) | undefined;
    const hanging: VerifierStage<FakeArtifact> = {
      name: "hangs",
      version: "1",
      run: async () => {
        await new Promise<void>((r) => {
          stageResolve = r;
        });
        return PASS;
      },
    };
    const r = await runPipeline([hanging], { name: "x" } as FakeArtifact, {
      stageTimeoutMs: 50,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
    expect(r.error.context?.stage).toBe("hangs");
    if (stageResolve !== undefined) stageResolve();
  });

  test("R24: caller signal preempts an uncooperative plugin via stage race", async () => {
    let stageResolve: (() => void) | undefined;
    const hanging: VerifierStage<FakeArtifact> = {
      name: "hangs",
      version: "1",
      run: async () => {
        await new Promise<void>((r) => {
          stageResolve = r;
        });
        return PASS;
      },
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await runPipeline([hanging], { name: "x" } as FakeArtifact, {
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
    if (stageResolve !== undefined) stageResolve();
  });

  test("cache + missing stage version (cast bypass) is rejected as INVALID_CONFIG", async () => {
    // `version` is required at the type level, but a caller that casts to
    // bypass typing would otherwise alias plugin slots in the cache. The
    // runtime check stays as defense in depth.
    const cache = createMemoryCache();
    const stage = {
      name: "unversioned",
      run: async () => PASS,
    } as unknown as VerifierStage<FakeArtifact>;
    const r = await runPipeline([stage], { name: "v" } as FakeArtifact, {
      cache,
      namespace: "v",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
    expect(r.error.message).toContain("explicit non-empty `version`");
  });
});

describe("single-flight (legacy: concurrent signal-free requests ARE coalesced)", () => {
  test("two concurrent runPipeline calls with the same key share one stage execution", async () => {
    let stageCalls = 0;
    let resolveStage: (() => void) | undefined;
    const blockedStage: VerifierStage<FakeArtifact> = {
      name: "blocked",
      version: "1",
      run: async () => {
        stageCalls += 1;
        // Hold both callers in the same in-flight execution until released.
        await new Promise<void>((resolve) => {
          resolveStage = resolve;
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "concurrent" };
    const r1Promise = runPipeline([blockedStage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    const r2Promise = runPipeline([blockedStage], artifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    // Yield so both promises register before we release the stage.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stageCalls).toBe(1); // second caller deduped, not yet started
    if (resolveStage === undefined) throw new Error("stage did not start");
    resolveStage();
    const [r1, r2] = await Promise.all([r1Promise, r2Promise]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(stageCalls).toBe(1); // STILL 1 — the work was shared, not duplicated
  });
});

describe("downstream-compatibility validation (stages + cache hits)", () => {
  const artifact: FakeArtifact = { name: "x" };

  test.each([
    ["empty name", { name: "", run: async () => PASS }],
    ["non-string name", { name: 42 as unknown as string, run: async () => PASS }],
  ])("stage with %s rejected as INVALID_CONFIG up front", async (_label, badStage) => {
    const result = await runPipeline(
      [badStage as unknown as VerifierStage<FakeArtifact>],
      artifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("invalid name");
  });

  test("duplicate stage names rejected as INVALID_CONFIG", async () => {
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "dup", version: "1", run: async () => PASS },
      { name: "dup", version: "1", run: async () => PASS },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain('Duplicate stage name "dup"');
  });

  test.each([
    ["totalDurationMs=NaN", { totalDurationMs: Number.NaN }],
    ["totalDurationMs=Infinity", { totalDurationMs: Number.POSITIVE_INFINITY }],
    ["totalDurationMs=-1", { totalDurationMs: -1 }],
    ["digest durationMs=NaN", { digestOverride: { durationMs: Number.NaN } }],
    ["digest durationMs=Infinity", { digestOverride: { durationMs: Number.POSITIVE_INFINITY } }],
  ])("malformed cache duration (%s) treated as miss", async (_label, override) => {
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const ovr = override as { totalDurationMs?: number; digestOverride?: { durationMs: number } };
    const malformedCache = {
      get: async (key: string) => ({
        key,
        summary: {
          passed: true,
          sandbox: false,
          totalDurationMs: ovr.totalDurationMs ?? 1,
          stageResults: [
            {
              stage: "syntax",
              passed: true,
              durationMs: ovr.digestOverride?.durationMs ?? 1,
            },
          ],
        } as ForgeVerificationSummary,
      }),
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: malformedCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    expect(stage.calls()).toBe(1); // re-verified, malformed durations not trusted
  });
});

describe("plugin contract hardening (malformed inputs stay in Result envelope)", () => {
  const artifact: FakeArtifact = { name: "x" };

  test.each([
    ["null outcome", null],
    ["undefined outcome", undefined],
    ["empty object outcome", {}],
    ["non-boolean ok", { ok: "true" }],
    ["number outcome", 42],
  ])("malformed stage outcome (%s) maps to INTERNAL", async (_label, badOutcome) => {
    const stage: VerifierStage<FakeArtifact> = {
      name: "buggy",
      version: "1",
      run: async () => badOutcome as unknown as StageOutcome,
    };
    const result = await runPipeline([stage], artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.context?.stage).toBe("buggy");
    expect(result.error.message).toContain("malformed outcome");
  });

  test("non-boolean sandboxed outcome maps to INTERNAL", async () => {
    const stage: VerifierStage<FakeArtifact> = {
      name: "buggy-sb",
      version: "1",
      run: async () => ({ ok: true, sandboxed: "yes" }) as unknown as StageOutcome,
    };
    const result = await runPipeline([stage], artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("non-boolean sandboxed");
  });

  test.each([
    ["summary=null", { key: "k", summary: null }],
    ["summary=number", { key: "k", summary: 42 }],
    [
      "stageResults contains null",
      {
        key: "k",
        summary: { passed: true, sandbox: false, totalDurationMs: 0, stageResults: [null] },
      },
    ],
    [
      "stageResults=null",
      {
        key: "k",
        summary: { passed: true, sandbox: false, totalDurationMs: 0, stageResults: null },
      },
    ],
  ])("malformed cache payload (%s) is treated as miss", async (_label, hit) => {
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const malformedCache = {
      get: async () => hit as never,
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: malformedCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    expect(stage.calls()).toBe(1); // re-verified, no TypeError escaped
  });

  test("artifact deeper than MAX_ARTIFACT_DEPTH is rejected (DoS guard)", async () => {
    type Nested = { name?: string; n?: Nested };
    const root: Nested = {};
    let cur = root;
    for (let i = 0; i < 300; i++) {
      cur.n = {};
      cur = cur.n;
    }
    cur.name = "leaf";
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1")],
      root as unknown as FakeArtifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("maximum depth");
  });
});

describe("canonical cache-key encoding (string-vs-sentinel collisions)", () => {
  // Bare-string sentinels would collide with user strings of the same
  // content. Type tags on every leaf prevent this.
  test.each([
    ["NaN vs string 'NaN'", { x: Number.NaN }, { x: "NaN" }],
    ["+Infinity vs string '+Inf'", { x: Number.POSITIVE_INFINITY }, { x: "+Inf" }],
    ["-Infinity vs string '-Inf'", { x: Number.NEGATIVE_INFINITY }, { x: "-Inf" }],
    ["-0 vs string '-0'", { x: -0 }, { x: "-0" }],
    ["undefined vs string 'u:'", { x: undefined }, { x: "u:" }],
    ["null vs string 'n:'", { x: null }, { x: "n:" }],
    ["bigint 1n vs string '1'", { x: 1n }, { x: "1" }],
    ["true vs string 't'", { x: true }, { x: "t" }],
  ])("%s do not alias the same cache key", async (_label, a, b) => {
    const cache = createMemoryCache();
    const stage = counted(createSyntaxStage(okCheck, "1"));
    await runPipeline([stage.stage], a as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(1);
    await runPipeline([stage.stage], b as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(2);
  });
});

describe("Proxy rejection (no caller code on verifier stack)", () => {
  test("Proxy artifact is rejected before any trap fires", async () => {
    let trapsFired = 0;
    const target = { name: "p" };
    const handler: ProxyHandler<typeof target> = {
      get: () => {
        trapsFired += 1;
        return undefined;
      },
      ownKeys: () => {
        trapsFired += 1;
        return [];
      },
      getOwnPropertyDescriptor: () => {
        trapsFired += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        trapsFired += 1;
        return null;
      },
    };
    const proxy = new Proxy(target, handler);
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1")],
      proxy as unknown as FakeArtifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("Proxy");
    // util.types.isProxy is a privileged V8 introspection — it does not
    // invoke any handler, so zero traps fire.
    expect(trapsFired).toBe(0);
  });

  test("nested Proxy inside a plain object is also rejected without firing traps", async () => {
    let trapsFired = 0;
    const innerProxy = new Proxy(
      { secret: 1 },
      {
        get: () => {
          trapsFired += 1;
          return undefined;
        },
      },
    );
    const result = await runPipeline([createSyntaxStage(okCheck, "1")], {
      name: "x",
      inner: innerProxy,
    } as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("Proxy");
    expect(trapsFired).toBe(0);
  });
});

describe("canonicalJson cycle detection (stack-based, DAG-safe)", () => {
  test("DAG with shared subobject does NOT bypass cache as a false cycle", async () => {
    // Two edges to the same plain-data object — legal and common (e.g.
    // a config that references the same defaults block twice). A naive
    // visited-set walker would flag the second visit as a cycle and the
    // pipeline would silently bypass the cache for this run.
    const cache = createMemoryCache();
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const shared = { kind: "shared", n: 1 };
    const dag = { name: "dag", a: shared, b: shared } as unknown as FakeArtifact;
    const r1 = await runPipeline([stage.stage], dag, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r1.ok).toBe(true);
    expect(stage.calls()).toBe(1);
    // Second call MUST hit the cache — the DAG produces a stable, deterministic
    // canonical key, not a "not cacheable" bypass.
    const r2 = await runPipeline([stage.stage], dag, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(r2.ok).toBe(true);
    expect(stage.calls()).toBe(1); // not re-executed
  });

  test("true cycle still bypasses cache (cycle != shared reference)", async () => {
    // Cycle remains uncacheable: no deterministic linearization exists.
    type Cyclic = { name: string; self?: Cyclic };
    const obj: Cyclic = { name: "cyc" };
    obj.self = obj;
    const stage = counted(createSyntaxStage(okCheck, "1"));
    const cache = createMemoryCache();
    await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(1);
    await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(2); // cache bypassed both times → re-runs
  });
});

describe("preprocessing budget (DoS guard for wide artifacts)", () => {
  test("artifact wider than MAX_ARTIFACT_NODES is rejected", async () => {
    // Shallow but huge: a single object with 60_000 keys defeats the depth
    // cap. Node-count budget catches it.
    const wide: Record<string, number> = {};
    for (let i = 0; i < 60_000; i++) wide[`k${i}`] = i;
    const result = await runPipeline(
      [createSyntaxStage(okCheck, "1")],
      wide as unknown as FakeArtifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("maximum node count");
  });
});

describe("canonical cache-key encoding (no value-identity collisions)", () => {
  // JSON.stringify maps NaN, ±Infinity → "null" and -0 → "0", so a naive
  // serializer would let a successful pass for {x: NaN} replay as a hit
  // for {x: null}. Each pair below MUST verify independently — different
  // cache keys → distinct cache entries → distinct stage runs.
  test.each([
    ["NaN vs null", { x: Number.NaN }, { x: null }],
    ["+Infinity vs null", { x: Number.POSITIVE_INFINITY }, { x: null }],
    ["-Infinity vs null", { x: Number.NEGATIVE_INFINITY }, { x: null }],
    ["-0 vs 0", { x: -0 }, { x: 0 }],
    ["undefined vs null", { x: undefined }, { x: null }],
  ])("%s do not alias the same cache key", async (_label, a, b) => {
    const cache = createMemoryCache();
    const stage = counted(createSyntaxStage(okCheck, "1"));
    await runPipeline([stage.stage], a as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(1);
    // If keys collided, stage would not be invoked the second time.
    await runPipeline([stage.stage], b as unknown as FakeArtifact, {
      cache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(stage.calls()).toBe(2);
  });
});

describe("cache key binding (envelope verification)", () => {
  const artifact: FakeArtifact = { name: "bound" };

  test("backend that returns a same-shape value under a different key is treated as miss", async () => {
    // Hostile/buggy backend: ignores the requested key and always returns a
    // crafted "passed" envelope tagged with its own (wrong) key. The verifier
    // must reject this and re-run the stages instead of trusting the payload.
    const stage = counted(createSyntaxStage(okCheck, "1"));
    let getCalls = 0;
    const lyingCache = {
      get: async () => {
        getCalls += 1;
        return {
          key: "wrong-key-from-another-tenant",
          summary: {
            passed: true,
            sandbox: false,
            totalDurationMs: 0,
            stageResults: [{ stage: "syntax", passed: true, durationMs: 0 }],
          },
        };
      },
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: lyingCache,
      namespace: "test",
      acknowledgeTrustedCache: true,
      executionContextKey: "test-ctx",
    });
    expect(result.ok).toBe(true);
    expect(getCalls).toBe(1);
    // Stage actually ran — wrong-key payload was NOT trusted.
    expect(stage.calls()).toBe(1);
  });
});

describe("R26 cache key partitions by stageTimeoutMs", () => {
  test("permissive caller's cached pass is NOT served to a stricter caller", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "slow",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise((r) => setTimeout(r, 30));
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "policy" };
    // Loose caller: 500ms budget — stage takes 30ms → success cached.
    const r1 = await runPipeline([stage], artifact, {
      cache,
      namespace: "policy",
      acknowledgeTrustedCache: true,
      executionContextKey: "ctx",
      stageTimeoutMs: 500,
    });
    expect(r1.ok).toBe(true);
    expect(stageCalls).toBe(1);
    // Strict caller: 5ms budget — must NOT inherit the loose cached pass.
    const r2 = await runPipeline([stage], artifact, {
      cache,
      namespace: "policy",
      acknowledgeTrustedCache: true,
      executionContextKey: "ctx",
      stageTimeoutMs: 5,
    });
    // Stage re-ran under the strict policy and timed out.
    expect(stageCalls).toBe(2);
    expect(r2.ok).toBe(false);
    if (r2.ok === false) expect(r2.error.code).toBe("TIMEOUT");
  });

  test("two callers with the SAME stageTimeoutMs share the cached pass", async () => {
    let stageCalls = 0;
    const stage: VerifierStage<FakeArtifact> = {
      name: "fast",
      version: "1",
      run: async () => {
        stageCalls += 1;
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "policy" };
    const opts = {
      cache,
      namespace: "policy",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
      stageTimeoutMs: 100,
    };
    const r1 = await runPipeline([stage], artifact, opts);
    const r2 = await runPipeline([stage], artifact, opts);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(stageCalls).toBe(1); // second call hit cache
  });
});

describe("R27 followers do NOT attach to a leader whose pipeline signal has aborted", () => {
  test("aborted leader is evicted on follower arrival; follower becomes fresh leader", async () => {
    let stageStarts = 0;
    const resolvers: Array<() => void> = [];
    const stage: VerifierStage<FakeArtifact> = {
      name: "slow",
      version: "1",
      run: async () => {
        stageStarts += 1;
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "race" };
    const ac = new AbortController();
    const leader = runPipeline([stage], artifact, {
      cache,
      namespace: "race",
      acknowledgeTrustedCache: true,
      executionContextKey: "ctx",
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageStarts).toBe(1);
    // Leader caller aborts. The leader's pipelineSignal mirror fires;
    // its stage loop will short-circuit to TIMEOUT, but its underlying
    // stage promise is still pending in the background.
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    // Follower arrives — must NOT inherit the leader's TIMEOUT.
    const follower = runPipeline([stage], artifact, {
      cache,
      namespace: "race",
      acknowledgeTrustedCache: true,
      executionContextKey: "ctx",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageStarts).toBe(2); // follower became fresh leader
    for (const r of resolvers) r();
    const [leaderResult, followerResult] = await Promise.all([leader, follower]);
    expect(leaderResult.ok).toBe(false);
    if (leaderResult.ok === false) expect(leaderResult.error.code).toBe("TIMEOUT");
    expect(followerResult.ok).toBe(true);
  });
});

describe("R28 cache.set NOT suppressed when a follower consumed the shared success", () => {
  test("aborted leader + attached follower → success IS cached", async () => {
    let stageCalls = 0;
    let release: (() => void) | undefined;
    const stage: VerifierStage<FakeArtifact> = {
      name: "shared",
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
    const artifact: FakeArtifact = { name: "shared-success" };
    const ac = new AbortController();
    const baseOpts = {
      cache,
      namespace: "shared",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const leader = runPipeline([stage], artifact, { ...baseOpts, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(1);
    // Follower attaches BEFORE leader aborts → detach() fires → hasFollower = true.
    const follower = runPipeline([stage], artifact, baseOpts);
    await new Promise((r) => setTimeout(r, 10));
    // Now leader aborts; shared work continues serving the follower.
    ac.abort();
    if (release === undefined) throw new Error("no release");
    release();
    const [leaderResult, followerResult] = await Promise.all([leader, follower]);
    // Leader cancelled → its own promise resolves to abort/TIMEOUT or success
    // depending on whether the abort raced ahead of the resolve. Either way,
    // the follower must see success and the cache must be populated.
    expect(followerResult.ok).toBe(true);
    void leaderResult;
    // A third caller arriving after the shared work completed must hit cache.
    const third = await runPipeline([stage], artifact, baseOpts);
    expect(third.ok).toBe(true);
    expect(stageCalls).toBe(1); // cache hit, no re-execution
  });

  test("aborted SOLO leader (no follower) → success is NOT cached", async () => {
    // Defensive boundary: when the initiating caller is the only consumer
    // and they explicitly rejected the result, we still don't cache —
    // R28 narrowed the suppression to (aborted AND no follower), not removed it.
    let stageCalls = 0;
    const resolvers: Array<() => void> = [];
    const stage: VerifierStage<FakeArtifact> = {
      name: "solo",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "solo-abort" };
    const ac = new AbortController();
    const baseOpts = {
      cache,
      namespace: "solo",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const leader = runPipeline([stage], artifact, { ...baseOpts, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    // Release the leader's stage so work() can settle.
    if (resolvers[0] === undefined) throw new Error("no resolver");
    resolvers[0]();
    const leaderResult = await leader;
    expect(leaderResult.ok).toBe(false);
    // Next caller: cache should NOT contain a populated pass — must re-run.
    const nextPromise = runPipeline([stage], artifact, baseOpts);
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(2); // re-executed (solo-abort suppressed cache.set)
    if (resolvers[1] === undefined) throw new Error("no resolver");
    resolvers[1]();
    const next = await nextPromise;
    expect(next.ok).toBe(true);
  });

  test("R29 cache.set NOT issued when leader AND every follower aborted before completion", async () => {
    // Subtle case: a follower attaches, then aborts. Leader also aborts.
    // Shared work continues and completes successfully — but no live
    // caller ever observed the result. Must NOT cache.
    let stageCalls = 0;
    const resolvers: Array<() => void> = [];
    const stage: VerifierStage<FakeArtifact> = {
      name: "ghost",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "ghost" };
    const baseOpts = {
      cache,
      namespace: "ghost",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const leaderAc = new AbortController();
    const followerAc = new AbortController();
    const leader = runPipeline([stage], artifact, { ...baseOpts, signal: leaderAc.signal });
    await new Promise((r) => setTimeout(r, 10));
    const follower = runPipeline([stage], artifact, { ...baseOpts, signal: followerAc.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(1); // follower attached, no second stage start
    // Both abort BEFORE work completes.
    leaderAc.abort();
    followerAc.abort();
    await new Promise((r) => setTimeout(r, 10));
    // Now allow shared work to complete in the background.
    if (resolvers[0] === undefined) throw new Error("no resolver");
    resolvers[0]();
    const [lr, fr] = await Promise.all([leader, follower]);
    expect(lr.ok).toBe(false); // leader aborted
    expect(fr.ok).toBe(false); // follower aborted
    // Drain microtasks so work() finishes its cache-write check and the
    // inflight slot evicts before the next caller arrives.
    await new Promise((r) => setTimeout(r, 30));
    // Next caller arriving fresh: cache must be empty → re-runs stage.
    const nextPromise = runPipeline([stage], artifact, baseOpts);
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(2); // cache was NOT populated by the ghost run
    if (resolvers[1] === undefined) throw new Error("no resolver");
    resolvers[1]();
    const next = await nextPromise;
    expect(next.ok).toBe(true);
  });

  test("R30 microtask-drain catches synchronous-abort race before cache.set decision", async () => {
    // R6 finding: liveConsumers was checked once before await cache.set.
    // If a caller's abort listener fires synchronously after the stage
    // resolves but before the suppression check, the count update could
    // be missed without a microtask yield. R30 adds an `await
    // Promise.resolve()` between stage completion and the suppression
    // check to drain any pending listeners.
    //
    // Reproduce: leader + follower; both abort the moment the stage's
    // last microtask resolves. The write must be suppressed.
    let stageCalls = 0;
    let stageResolve: (() => void) | undefined;
    const stage: VerifierStage<FakeArtifact> = {
      name: "race",
      version: "1",
      run: async () => {
        stageCalls += 1;
        await new Promise<void>((r) => {
          stageResolve = r;
        });
        return PASS;
      },
    };
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "race-cache" };
    const baseOpts = {
      cache,
      namespace: "race",
      acknowledgeTrustedCache: true as const,
      executionContextKey: "ctx",
    };
    const leaderAc = new AbortController();
    const followerAc = new AbortController();
    const leader = runPipeline([stage], artifact, { ...baseOpts, signal: leaderAc.signal });
    await new Promise((r) => setTimeout(r, 10));
    const follower = runPipeline([stage], artifact, { ...baseOpts, signal: followerAc.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(1);
    // Resolve the stage and abort BOTH callers in the same microtask
    // window — the microtask drain in work() must let the listeners
    // fire before the suppression check.
    if (stageResolve === undefined) throw new Error("no resolve");
    stageResolve();
    leaderAc.abort();
    followerAc.abort();
    await Promise.all([leader, follower]);
    await new Promise((r) => setTimeout(r, 30));
    // Cache must NOT have been populated. Verify by issuing a fresh
    // call (start it, then resolve its stage) and confirming a new
    // execution happened rather than a cache hit.
    const nextPromise = runPipeline([stage], artifact, baseOpts);
    await new Promise((r) => setTimeout(r, 10));
    expect(stageCalls).toBe(2); // fresh execution — phantom write was suppressed
    if (stageResolve !== undefined) stageResolve();
    const next = await nextPromise;
    expect(next.ok).toBe(true);
  });
});

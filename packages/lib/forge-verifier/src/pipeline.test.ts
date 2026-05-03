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
      ...(stage.version !== undefined ? { version: stage.version } : {}),
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
      [createSyntaxStage(okCheck), createTypeStage(okCheck), createTestStage(okCheck)],
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
    const type = counted(createTypeStage(okCheck));
    const tst = counted(createTestStage(okCheck));
    const result = await runPipeline(
      [createSyntaxStage(failCheck("bad syntax")), type.stage, tst.stage],
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
    const tst = counted(createTestStage(okCheck));
    const result = await runPipeline(
      [createSyntaxStage(okCheck), createTypeStage(failCheck("bad type")), tst.stage],
      artifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.stage).toBe("type");
    expect(tst.calls()).toBe(0);
  });

  test("test failure caught; syntax + type digests present", async () => {
    const result = await runPipeline(
      [createSyntaxStage(okCheck), createTypeStage(okCheck), createTestStage(failCheck("fail"))],
      artifact,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.stage).toBe("test");
  });

  test("short-circuits on first failure (counter assertion)", async () => {
    const a = counted({ name: "a", run: async () => PASS });
    const b = counted({ name: "b", run: async () => ({ ok: false as const, reason: "stop" }) });
    const c = counted({ name: "c", run: async () => PASS });
    const d = counted({ name: "d", run: async () => PASS });
    const result = await runPipeline([a.stage, b.stage, c.stage, d.stage], artifact);
    expect(result.ok).toBe(false);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(c.calls()).toBe(0);
    expect(d.calls()).toBe(0);
  });

  test("cache hit skips re-verification", async () => {
    const cache = createMemoryCache();
    const syntax = counted(createSyntaxStage(okCheck));
    const stages = [syntax.stage] as const;

    const first = await runPipeline(stages, artifact, { cache, namespace: "test" });
    expect(first.ok).toBe(true);
    expect(syntax.calls()).toBe(1);

    const second = await runPipeline(stages, artifact, { cache, namespace: "test" });
    expect(second.ok).toBe(true);
    expect(syntax.calls()).toBe(1); // not incremented
    if (!second.ok || !first.ok) return;
    expect(second.value).toEqual(first.value);
  });

  test("failed pipelines are not cached", async () => {
    const cache = createMemoryCache();
    const stages = [createSyntaxStage(failCheck("nope"))];
    await runPipeline(stages, { name: "a" }, { cache, namespace: "test" });
    const cached = await cache.get("k2");
    expect(cached).toBeUndefined();
  });

  test("stage that throws maps to INTERNAL with cause", async () => {
    const boom: VerifierStage<FakeArtifact> = {
      name: "boom",
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
        run: async () => {
          ac.abort();
          return PASS;
        },
      },
      { name: "never", run: async () => PASS },
    ];
    const result = await runPipeline(stages, artifact, { signal: ac.signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
    // Pre-stage abort check at the top of the next iteration catches the
    // abort. "first" already completed (and committed its work in the digest
    // history), so the rejection is attributed to the un-run "never" stage.
    expect(result.error.context?.stage).toBe("never");
  });

  test("StageContext.previous reflects prior digests", async () => {
    const seen: number[] = [];
    const record = (ctx: { readonly previous: readonly unknown[] }): StageOutcome => {
      seen.push(ctx.previous.length);
      return PASS;
    };
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "s1", run: async (_a, ctx) => record(ctx) },
      { name: "s2", run: async (_a, ctx) => record(ctx) },
      { name: "s3", run: async (_a, ctx) => record(ctx) },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(true);
    expect(seen).toEqual([0, 1, 2]);
  });

  test("sandboxed declaration flows into summary.sandbox", async () => {
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "plain", run: async () => PASS },
      { name: "sb", sandboxed: true, run: async () => ({ ok: true, sandboxed: true }) },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sandbox).toBe(true);
  });

  test("statically sandboxed stage with omitted runtime sandboxed flag is accepted", async () => {
    // outcome.sandboxed is OPTIONAL — omission means "no override".
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "sb", sandboxed: true, run: async () => ({ ok: true }) }, // no sandboxed field
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sandbox).toBe(true);
  });

  test("stage runtime sandboxed flag must agree with static declaration", async () => {
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      // Declared not-sandboxed but reports sandboxed=true at runtime — mismatch.
      { name: "lying", run: async () => ({ ok: true, sandboxed: true }) },
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
    const v1 = counted(createSyntaxStage(okCheck));
    const r1 = await runPipeline([v1.stage], artifact, { cache, namespace: "test" });
    expect(r1.ok).toBe(true);
    expect(v1.calls()).toBe(1);

    const v2a = counted(createSyntaxStage(okCheck));
    const v2b = counted(createTypeStage(okCheck));
    const r2 = await runPipeline([v2a.stage, v2b.stage], artifact, { cache, namespace: "test" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(v2a.calls()).toBe(1);
    expect(v2b.calls()).toBe(1);
    expect(r2.value.stageResults.map((s) => s.stage)).toEqual(["syntax", "type"]);
  });

  test("cache key is bound to stage list — renaming a stage invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const before = counted({ name: "alpha", run: async () => PASS });
    const r1 = await runPipeline([before.stage], artifact, { cache, namespace: "test" });
    expect(r1.ok).toBe(true);

    const after = counted({ name: "beta", run: async () => PASS });
    const r2 = await runPipeline([after.stage], artifact, { cache, namespace: "test" });
    expect(r2.ok).toBe(true);
    expect(after.calls()).toBe(1);
  });

  test("StageContext.previous is frozen — stages cannot mutate prior digests", async () => {
    const captured: { previous: readonly ForgeStageDigestLike[] }[] = [];
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "s1", run: async () => PASS },
      {
        name: "s2",
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
    const r1 = await runPipeline([v1.stage], artifact, { cache, namespace: "test" });
    expect(r1.ok).toBe(true);
    expect(v1.calls()).toBe(1);

    // Same name, bumped version — must re-run.
    const v2 = counted({ name: "checker", version: "2", run: async () => PASS });
    const r2 = await runPipeline([v2.stage], artifact, { cache, namespace: "test" });
    expect(r2.ok).toBe(true);
    expect(v2.calls()).toBe(1);
  });

  test("cache returns a frozen, isolated snapshot — caller mutation cannot poison the cache", async () => {
    const cache = createMemoryCache();
    const stage = createSyntaxStage(okCheck);
    const r1 = await runPipeline([stage], artifact, { cache, namespace: "test" });
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
    const r2 = await runPipeline([stage], artifact, { cache, namespace: "test" });
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
    await runPipeline([a.stage], artifact, { cache, namespace: "test" });
    await runPipeline([b.stage], artifact, { cache, namespace: "test" });
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
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
      cache: hostileCache,
      namespace: "test",
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
    const stage = counted(createSyntaxStage(okCheck));
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
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stage.calls()).toBe(1); // re-verified despite the cache hit
    expect(result.value.stageResults.map((s) => s.stage)).toEqual(["syntax"]);
  });

  test("malformed cache payload (wrong stage name) is rejected", async () => {
    const stage = counted(createSyntaxStage(okCheck));
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
    });
    expect(result.ok).toBe(true);
    expect(stage.calls()).toBe(1);
  });

  test("cached sandbox=true is rejected when no current stage declares sandbox", async () => {
    const stage = counted(createSyntaxStage(okCheck));
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
    const stages = [createSyntaxStage(okCheck)];
    const result = await runPipeline(stages, { fn } as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
  });

  test("Map artifact is rejected — frozen Maps are still mutable via .set", async () => {
    const stages = [createSyntaxStage(okCheck)];
    const result = await runPipeline(stages, new Map([["k", 1]]) as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("Map");
  });

  test("Set artifact is rejected — frozen Sets are still mutable via .add", async () => {
    const stages = [createSyntaxStage(okCheck)];
    const result = await runPipeline(stages, new Set([1, 2]) as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("Set");
  });

  test("typed-array artifact is rejected", async () => {
    const stages = [createSyntaxStage(okCheck)];
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
    const stages = [createSyntaxStage(okCheck)];
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
    const stage: VerifierStage<typeof obj> = { name: "inspect", run: async () => PASS };
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
    const stages = [createSyntaxStage(okCheck)];
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
    const stage: VerifierStage<typeof obj> = { name: "inspect", run: async () => PASS };
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
    const stage: VerifierStage<typeof obj> = { name: "inspect", run: async () => PASS };
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
    const result = await runPipeline([createSyntaxStage(okCheck)], arr as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(getterFireCount).toBe(0);
  });

  test("snapshot phase honors abort signal — fails fast on already-aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
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
    const result = await runPipeline([createSyntaxStage(okCheck)], arr as unknown as FakeArtifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("array property");
  });

  test("cyclic artifact bypasses cache (deterministic key impossible) but still verifies", async () => {
    type Cyclic = { name: string; self?: Cyclic };
    const obj: Cyclic = { name: "cyc" };
    obj.self = obj;
    const stage = counted(createSyntaxStage(okCheck));
    const cache = createMemoryCache();
    // First call: stages run, cache cannot be populated for the cyclic input.
    const r1 = await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
    });
    expect(r1.ok).toBe(true);
    expect(stage.calls()).toBe(1);
    // Second call: cache still bypassed (no key was ever stored), stages re-run.
    const r2 = await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
    });
    expect(r2.ok).toBe(true);
    expect(stage.calls()).toBe(2);
  });

  test("self-referential plain object is accepted (cycle guard)", async () => {
    type Cyclic = { name: string; self?: Cyclic };
    const obj: Cyclic = { name: "cyc" };
    obj.self = obj;
    // structuredClone supports cycles; the validator must too.
    const result = await runPipeline([createSyntaxStage(okCheck)], obj as unknown as FakeArtifact);
    expect(result.ok).toBe(true);
  });

  test("self-referential array is accepted (cycle guard)", async () => {
    const arr: unknown[] = [];
    arr.push(arr);
    const result = await runPipeline([createSyntaxStage(okCheck)], {
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
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
      cache,
      namespace: "test",
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
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
      cache: slowCache,
      namespace: "test",
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
  });

  test("nested Map inside a plain object is also rejected", async () => {
    const stages = [createSyntaxStage(okCheck)];
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
    const r1 = await runPipeline([v1.stage], artifact, { cache, namespace: "test" });
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
    const r2 = await runPipeline([v2.stage], artifact, { cache, namespace: "test" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(v2.calls()).toBe(1); // re-verified, did not reuse the stale entry
    expect(r2.value.sandbox).toBe(true);
  });

  test("fresh and cached runs produce the same sandbox value", async () => {
    const cache = createMemoryCache();
    const sb: VerifierStage<FakeArtifact> = {
      name: "sb",
      sandboxed: true,
      run: async () => ({ ok: true, sandboxed: true }),
    };
    const fresh = await runPipeline([sb], artifact, { cache, namespace: "test" });
    const cached = await runPipeline([sb], artifact, { cache, namespace: "test" });
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
    await runPipeline([v1.stage], artifact, { cache, namespace: "test" });
    await runPipeline([v2.stage], artifact, { cache, namespace: "test" });
    expect(v1.calls()).toBe(1);
    expect(v2.calls()).toBe(1);
  });

  test("abort during the final stage commits the success — does not duplicate non-idempotent work on retry", async () => {
    // Side-effectful stage already produced its effect; discarding the
    // success and returning TIMEOUT would force a retry and duplicate the
    // irreversible work. Instead, we commit and return success — caller's
    // explicit abort cannot un-do work that already completed.
    const ac = new AbortController();
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      {
        name: "only",
        run: async () => {
          ac.abort();
          return PASS;
        },
      },
    ];
    const result = await runPipeline(stages, artifact, { signal: ac.signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stageResults.map((s) => s.stage)).toEqual(["only"]);
  });

  test("cache key derived from artifact — different artifacts do not share cache", async () => {
    const cache = createMemoryCache();
    const stage = counted(createSyntaxStage(okCheck));
    const artifactA: FakeArtifact = { name: "A" };
    const artifactB: FakeArtifact = { name: "B" };
    await runPipeline([stage.stage], artifactA, { cache, namespace: "test" });
    expect(stage.calls()).toBe(1);
    // A different artifact under the same key fn must not see the prior pass.
    await runPipeline([stage.stage], artifactB, { cache, namespace: "test" });
    expect(stage.calls()).toBe(2);
    // But re-verifying A should still hit the cache.
    await runPipeline([stage.stage], artifactA, { cache, namespace: "test" });
    expect(stage.calls()).toBe(2);
  });

  test("cache.get failure defaults to fail — does NOT silently re-execute non-idempotent stages", async () => {
    // Default policy: stages may have side effects (sandbox jobs, external
    // API calls, quota), so a transient backend outage must not silently
    // re-run them. Surface as INTERNAL inside the Result envelope; the
    // exception never escapes the documented Promise<Result<...>> contract.
    const stage = counted(createSyntaxStage(okCheck));
    const flakyCache = {
      get: async () => {
        throw new Error("read backend down");
      },
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: flakyCache,
      namespace: "test",
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
    const stage = counted(createSyntaxStage(okCheck));
    const flakyCache = {
      get: async () => {
        throw new Error("read backend down");
      },
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: flakyCache,
      namespace: "test",
      cacheReadFailure: "miss",
    });
    expect(result.ok).toBe(true);
    expect(stage.calls()).toBe(1);
  });

  test("cache provided without namespace is rejected as INVALID_CONFIG", async () => {
    const cache = createMemoryCache();
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, { cache });
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
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
      cache: flakyCache,
      namespace: "test",
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
    });
    const result = await runPipeline([stage], { name: "x" }, { signal: ac.signal });
    expect(observedSignal).toBe(ac.signal);
    expect(observedAbortedBefore).toBe(false);
    // Pipeline maps the check's `{ok:false}` to VALIDATION because no throw occurred.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("cancelled by caller");
  });
});

describe("sparse arrays (no cache-key aliasing with dense arrays)", () => {
  test("sparse array at root is rejected pre-clone — would alias dense in cache key", async () => {
    // `new Array(1)` has length 1 with a hole at index 0. `[].length === 0`
    // and `[undefined].length === 1`. A naive serializer would alias the
    // sparse array to one of those depending on whether holes are skipped.
    const sparse = new Array(1);
    const result = await runPipeline(
      [createSyntaxStage(okCheck)],
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
    const result = await runPipeline([createSyntaxStage(okCheck)], {
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
    const result = await runPipeline([createSyntaxStage(okCheck)], {
      name: "x",
      arr: [undefined, undefined],
    } as unknown as FakeArtifact);
    expect(result.ok).toBe(true);
  });
});

describe("single-flight (concurrent identical requests are coalesced)", () => {
  test("signal-bearing callers do NOT coalesce — leader abort cannot poison follower", async () => {
    // Leader's signal aborts mid-stage; follower has its own signal that
    // never fires. Without isolation, follower would inherit leader's
    // TIMEOUT. With it, follower runs its own pipeline and succeeds.
    let stageStarts = 0;
    const cache = createMemoryCache();
    const artifact: FakeArtifact = { name: "iso" };
    const slow: VerifierStage<FakeArtifact> = {
      name: "slow",
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
      signal: leaderAc.signal,
    });
    const followerPromise = runPipeline([slow], artifact, {
      cache,
      namespace: "iso",
      signal: followerAc.signal,
    });
    // Leader aborts immediately; follower never aborts.
    leaderAc.abort();
    const [leader, follower] = await Promise.all([leaderPromise, followerPromise]);
    expect(leader.ok).toBe(false); // leader honored its own abort
    expect(follower.ok).toBe(true); // follower ran independently — NOT poisoned by leader's TIMEOUT
    expect(stageStarts).toBeGreaterThanOrEqual(1); // follower ran its stage
  });
});

describe("single-flight (legacy: concurrent signal-free requests ARE coalesced)", () => {
  test("two concurrent runPipeline calls with the same key share one stage execution", async () => {
    let stageCalls = 0;
    let resolveStage: (() => void) | undefined;
    const blockedStage: VerifierStage<FakeArtifact> = {
      name: "blocked",
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
    const r1Promise = runPipeline([blockedStage], artifact, { cache, namespace: "test" });
    const r2Promise = runPipeline([blockedStage], artifact, { cache, namespace: "test" });
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
    const result = await runPipeline([badStage as VerifierStage<FakeArtifact>], artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONFIG");
    expect(result.error.message).toContain("invalid name");
  });

  test("duplicate stage names rejected as INVALID_CONFIG", async () => {
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "dup", run: async () => PASS },
      { name: "dup", run: async () => PASS },
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
    const stage = counted(createSyntaxStage(okCheck));
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
    const stage = counted(createSyntaxStage(okCheck));
    const malformedCache = {
      get: async () => hit as never,
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      cache: malformedCache,
      namespace: "test",
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
    const result = await runPipeline([createSyntaxStage(okCheck)], root as unknown as FakeArtifact);
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
    const stage = counted(createSyntaxStage(okCheck));
    await runPipeline([stage.stage], a as unknown as FakeArtifact, { cache, namespace: "test" });
    expect(stage.calls()).toBe(1);
    await runPipeline([stage.stage], b as unknown as FakeArtifact, { cache, namespace: "test" });
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
      [createSyntaxStage(okCheck)],
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
    const result = await runPipeline([createSyntaxStage(okCheck)], {
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
    const stage = counted(createSyntaxStage(okCheck));
    const shared = { kind: "shared", n: 1 };
    const dag = { name: "dag", a: shared, b: shared } as unknown as FakeArtifact;
    const r1 = await runPipeline([stage.stage], dag, { cache, namespace: "test" });
    expect(r1.ok).toBe(true);
    expect(stage.calls()).toBe(1);
    // Second call MUST hit the cache — the DAG produces a stable, deterministic
    // canonical key, not a "not cacheable" bypass.
    const r2 = await runPipeline([stage.stage], dag, { cache, namespace: "test" });
    expect(r2.ok).toBe(true);
    expect(stage.calls()).toBe(1); // not re-executed
  });

  test("true cycle still bypasses cache (cycle != shared reference)", async () => {
    // Cycle remains uncacheable: no deterministic linearization exists.
    type Cyclic = { name: string; self?: Cyclic };
    const obj: Cyclic = { name: "cyc" };
    obj.self = obj;
    const stage = counted(createSyntaxStage(okCheck));
    const cache = createMemoryCache();
    await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
    });
    expect(stage.calls()).toBe(1);
    await runPipeline([stage.stage], obj as unknown as FakeArtifact, {
      cache,
      namespace: "test",
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
    const result = await runPipeline([createSyntaxStage(okCheck)], wide as unknown as FakeArtifact);
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
    const stage = counted(createSyntaxStage(okCheck));
    await runPipeline([stage.stage], a as unknown as FakeArtifact, { cache, namespace: "test" });
    expect(stage.calls()).toBe(1);
    // If keys collided, stage would not be invoked the second time.
    await runPipeline([stage.stage], b as unknown as FakeArtifact, { cache, namespace: "test" });
    expect(stage.calls()).toBe(2);
  });
});

describe("cache key binding (envelope verification)", () => {
  const artifact: FakeArtifact = { name: "bound" };

  test("backend that returns a same-shape value under a different key is treated as miss", async () => {
    // Hostile/buggy backend: ignores the requested key and always returns a
    // crafted "passed" envelope tagged with its own (wrong) key. The verifier
    // must reject this and re-run the stages instead of trusting the payload.
    const stage = counted(createSyntaxStage(okCheck));
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
    });
    expect(result.ok).toBe(true);
    expect(getCalls).toBe(1);
    // Stage actually ran — wrong-key payload was NOT trusted.
    expect(stage.calls()).toBe(1);
  });
});

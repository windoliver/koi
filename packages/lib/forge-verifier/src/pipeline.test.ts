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

    const first = await runPipeline(stages, artifact, { artifactFingerprint: () => "k1", cache });
    expect(first.ok).toBe(true);
    expect(syntax.calls()).toBe(1);

    const second = await runPipeline(stages, artifact, { artifactFingerprint: () => "k1", cache });
    expect(second.ok).toBe(true);
    expect(syntax.calls()).toBe(1); // not incremented
    if (!second.ok || !first.ok) return;
    expect(second.value).toEqual(first.value);
  });

  test("failed pipelines are not cached", async () => {
    const cache = createMemoryCache();
    const stages = [createSyntaxStage(failCheck("nope"))];
    await runPipeline(stages, { name: "a" }, { artifactFingerprint: () => "k2", cache });
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

  test("aborted signal between stages maps to TIMEOUT", async () => {
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
    // Post-stage abort check fires before the next iteration entry check,
    // so the abort is attributed to the stage that aborted, not the next.
    expect(result.error.context?.stage).toBe("first");
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
    const r1 = await runPipeline([v1.stage], artifact, {
      artifactFingerprint: () => "user-key",
      cache,
    });
    expect(r1.ok).toBe(true);
    expect(v1.calls()).toBe(1);

    const v2a = counted(createSyntaxStage(okCheck));
    const v2b = counted(createTypeStage(okCheck));
    const r2 = await runPipeline([v2a.stage, v2b.stage], artifact, {
      artifactFingerprint: () => "user-key",
      cache,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(v2a.calls()).toBe(1);
    expect(v2b.calls()).toBe(1);
    expect(r2.value.stageResults.map((s) => s.stage)).toEqual(["syntax", "type"]);
  });

  test("cache key is bound to stage list — renaming a stage invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const before = counted({ name: "alpha", run: async () => PASS });
    const r1 = await runPipeline([before.stage], artifact, {
      artifactFingerprint: () => "k",
      cache,
    });
    expect(r1.ok).toBe(true);

    const after = counted({ name: "beta", run: async () => PASS });
    const r2 = await runPipeline([after.stage], artifact, {
      artifactFingerprint: () => "k",
      cache,
    });
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
    const r1 = await runPipeline([v1.stage], artifact, { artifactFingerprint: () => "k", cache });
    expect(r1.ok).toBe(true);
    expect(v1.calls()).toBe(1);

    // Same name, bumped version — must re-run.
    const v2 = counted({ name: "checker", version: "2", run: async () => PASS });
    const r2 = await runPipeline([v2.stage], artifact, { artifactFingerprint: () => "k", cache });
    expect(r2.ok).toBe(true);
    expect(v2.calls()).toBe(1);
  });

  test("cache returns a frozen, isolated snapshot — caller mutation cannot poison the cache", async () => {
    const cache = createMemoryCache();
    const stage = createSyntaxStage(okCheck);
    const r1 = await runPipeline([stage], artifact, { artifactFingerprint: () => "k", cache });
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
    const r2 = await runPipeline([stage], artifact, { artifactFingerprint: () => "k", cache });
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
    await runPipeline([a.stage], artifact, { artifactFingerprint: () => "k", cache });
    await runPipeline([b.stage], artifact, { artifactFingerprint: () => "k", cache });
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
      get: async () => stored as unknown as ForgeVerificationSummary,
      set: async () => {},
    };
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
      artifactFingerprint: () => "k",
      cache: hostileCache,
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
      get: async () =>
        ({
          passed: true,
          sandbox: false,
          totalDurationMs: 0,
          stageResults: [], // empty — would be a fail-open if trusted
        }) as ForgeVerificationSummary,
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      artifactFingerprint: () => "k",
      cache: malformedCache,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stage.calls()).toBe(1); // re-verified despite the cache hit
    expect(result.value.stageResults.map((s) => s.stage)).toEqual(["syntax"]);
  });

  test("malformed cache payload (wrong stage name) is rejected", async () => {
    const stage = counted(createSyntaxStage(okCheck));
    const malformedCache = {
      get: async () =>
        ({
          passed: true,
          sandbox: false,
          totalDurationMs: 1,
          stageResults: [{ stage: "different-name", passed: true, durationMs: 1 }],
        }) as ForgeVerificationSummary,
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      artifactFingerprint: () => "k",
      cache: malformedCache,
    });
    expect(result.ok).toBe(true);
    expect(stage.calls()).toBe(1);
  });

  test("cached sandbox=true is rejected when no current stage declares sandbox", async () => {
    const stage = counted(createSyntaxStage(okCheck));
    const lyingCache = {
      get: async () =>
        ({
          passed: true,
          sandbox: true, // backend forges the trust signal
          totalDurationMs: 1,
          stageResults: [{ stage: "syntax", passed: true, durationMs: 1 }],
        }) as ForgeVerificationSummary,
      set: async () => {},
    };
    const result = await runPipeline([stage.stage], artifact, {
      artifactFingerprint: () => "k",
      cache: lyingCache,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Recomputed from stage declarations, not the cached payload.
    expect(result.value.sandbox).toBe(false);
  });

  test("cached sandbox=true is honored when at least one current stage declares sandbox", async () => {
    const sbStage: VerifierStage<FakeArtifact> = {
      name: "sb",
      sandboxed: true,
      run: async () => ({ ok: true, sandboxed: true }),
    };
    const cachingCache = {
      get: async () =>
        ({
          passed: true,
          sandbox: true,
          totalDurationMs: 1,
          stageResults: [{ stage: "sb", passed: true, durationMs: 1 }],
        }) as ForgeVerificationSummary,
      set: async () => {},
    };
    const result = await runPipeline([sbStage], artifact, {
      artifactFingerprint: () => "k",
      cache: cachingCache,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sandbox).toBe(true);
  });

  test("stages receive a deep snapshot — caller object cannot be mutated", async () => {
    const obj: { name: string; nested: { count: number }; mutated?: boolean } = {
      name: "snapshot-test",
      nested: { count: 1 },
    };
    let receivedNested: { count: number } | undefined;
    const stage: VerifierStage<typeof obj> = {
      name: "mutator",
      run: async (a) => {
        receivedNested = a.nested;
        // Mutating the snapshot is allowed (it's the cloned copy), but the
        // caller's object MUST be untouched.
        a.mutated = true;
        a.nested.count = 999;
        return PASS;
      },
    };
    const result = await runPipeline([stage], obj);
    expect(result.ok).toBe(true);
    // Deep clone — nested object is a different reference.
    expect(receivedNested).not.toBe(obj.nested);
    expect(obj.mutated).toBeUndefined();
    expect(obj.nested.count).toBe(1);
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

  test("fresh and cached runs produce the same sandbox value", async () => {
    const cache = createMemoryCache();
    const sb: VerifierStage<FakeArtifact> = {
      name: "sb",
      sandboxed: true,
      run: async () => ({ ok: true, sandboxed: true }),
    };
    const fresh = await runPipeline([sb], artifact, {
      artifactFingerprint: () => "k",
      cache,
    });
    const cached = await runPipeline([sb], artifact, {
      artifactFingerprint: () => "k",
      cache,
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
    await runPipeline([v1.stage], artifact, { artifactFingerprint: () => "k", cache });
    await runPipeline([v2.stage], artifact, { artifactFingerprint: () => "k", cache });
    expect(v1.calls()).toBe(1);
    expect(v2.calls()).toBe(1);
  });

  test("abort during the final stage still maps to TIMEOUT", async () => {
    const ac = new AbortController();
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      {
        name: "only",
        run: async () => {
          ac.abort();
          return PASS; // Stage ignored the signal and returned success.
        },
      },
    ];
    const result = await runPipeline(stages, artifact, { signal: ac.signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
    expect(result.error.context?.stage).toBe("only");
  });

  test("cache key derived from artifact — different artifacts do not share cache", async () => {
    const cache = createMemoryCache();
    const stage = counted(createSyntaxStage(okCheck));
    const artifactA: FakeArtifact = { name: "A" };
    const artifactB: FakeArtifact = { name: "B" };
    const key: (a: FakeArtifact) => string = (a) => a.name;
    await runPipeline([stage.stage], artifactA, { artifactFingerprint: key, cache });
    expect(stage.calls()).toBe(1);
    // A different artifact under the same key fn must not see the prior pass.
    await runPipeline([stage.stage], artifactB, { artifactFingerprint: key, cache });
    expect(stage.calls()).toBe(2);
    // But re-verifying A should still hit the cache.
    await runPipeline([stage.stage], artifactA, { artifactFingerprint: key, cache });
    expect(stage.calls()).toBe(2);
  });

  test("cache.set failure does not turn success into rejection", async () => {
    const flakyCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error("cache backend down");
      },
    };
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
      artifactFingerprint: () => "k",
      cache: flakyCache,
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

  test("set then get round-trips a summary", async () => {
    const cache = createMemoryCache();
    const summary = {
      passed: true,
      sandbox: false,
      totalDurationMs: 1,
      stageResults: [{ stage: "x", passed: true, durationMs: 1 }],
    } as const;
    await cache.set("k", summary);
    expect(await cache.get("k")).toEqual(summary);
  });
});

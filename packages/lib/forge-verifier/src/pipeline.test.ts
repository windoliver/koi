import { describe, expect, test } from "bun:test";
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

    const first = await runPipeline(stages, artifact, { cacheKey: "k1", cache });
    expect(first.ok).toBe(true);
    expect(syntax.calls()).toBe(1);

    const second = await runPipeline(stages, artifact, { cacheKey: "k1", cache });
    expect(second.ok).toBe(true);
    expect(syntax.calls()).toBe(1); // not incremented
    if (!second.ok || !first.ok) return;
    expect(second.value).toEqual(first.value);
  });

  test("failed pipelines are not cached", async () => {
    const cache = createMemoryCache();
    const stages = [createSyntaxStage(failCheck("nope"))];
    await runPipeline(stages, { name: "a" }, { cacheKey: "k2", cache });
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

  test("sandboxed flag from a stage flows into summary.sandbox", async () => {
    const stages: readonly VerifierStage<FakeArtifact>[] = [
      { name: "plain", run: async () => PASS },
      { name: "sb", run: async () => ({ ok: true, sandboxed: true }) },
    ];
    const result = await runPipeline(stages, artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sandbox).toBe(true);
  });
});

describe("runPipeline — security regressions", () => {
  const artifact: FakeArtifact = { name: "sec" };

  test("cache key is bound to stage list — adding a new stage invalidates prior cache", async () => {
    const cache = createMemoryCache();
    const v1 = counted(createSyntaxStage(okCheck));
    const r1 = await runPipeline([v1.stage], artifact, { cacheKey: "user-key", cache });
    expect(r1.ok).toBe(true);
    expect(v1.calls()).toBe(1);

    const v2a = counted(createSyntaxStage(okCheck));
    const v2b = counted(createTypeStage(okCheck));
    const r2 = await runPipeline([v2a.stage, v2b.stage], artifact, {
      cacheKey: "user-key",
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
    const r1 = await runPipeline([before.stage], artifact, { cacheKey: "k", cache });
    expect(r1.ok).toBe(true);

    const after = counted({ name: "beta", run: async () => PASS });
    const r2 = await runPipeline([after.stage], artifact, { cacheKey: "k", cache });
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

  test("cache.set failure does not turn success into rejection", async () => {
    const flakyCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error("cache backend down");
      },
    };
    const result = await runPipeline([createSyntaxStage(okCheck)], artifact, {
      cacheKey: "k",
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

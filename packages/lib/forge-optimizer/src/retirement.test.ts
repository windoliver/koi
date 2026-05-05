import { describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  BrickArtifactBase,
  BrickFitnessMetrics,
  ToolArtifact,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { type RetirementPolicy, suggestRetirement } from "./retirement.js";

const baseFields: Omit<
  BrickArtifactBase,
  "kind" | "name" | "description" | "id" | "lifecycle" | "usageCount" | "fitness"
> = {
  scope: "agent",
  origin: "operator",
  policy: DEFAULT_UNSANDBOXED_POLICY,
  provenance: {} as BrickArtifactBase["provenance"],
  version: "1.0.0",
  tags: [],
};

function tool(opts: {
  id: string;
  lifecycle?: BrickArtifactBase["lifecycle"];
  usageCount?: number;
  fitness?: BrickFitnessMetrics;
}): ToolArtifact {
  return {
    ...baseFields,
    id: `sha256:${opts.id}` as ToolArtifact["id"],
    kind: "tool",
    name: opts.id,
    description: "",
    lifecycle: opts.lifecycle ?? "active",
    usageCount: opts.usageCount ?? 0,
    fitness: opts.fitness,
    implementation: "",
    inputSchema: {},
  };
}

const POLICY: RetirementPolicy = {
  minUsageCount: 5,
  maxIdleMs: 1000,
  minSuccessRate: 0.5,
  minSampleSize: 10,
};

describe("suggestRetirement", () => {
  test("flags brick with usageCount below threshold (with corroborating fitness)", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 0,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 1, fitness })], POLICY, 0);
    expect(r.length).toBe(1);
    expect(r[0]?.brickId).toBe(`sha256:a` as BrickArtifact["id"]);
    expect(r[0]?.kind).toBe("retire");
    expect(r[0]?.reason).toContain("usage");
  });

  test("low usageCount + missing fitness surfaces as integrity (telemetry could be stale)", () => {
    const r = suggestRetirement([tool({ id: "a", usageCount: 1 })], POLICY, 0);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
  });

  test("flags brick idle past maxIdleMs", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 10,
      errorCount: 0,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 0,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 10, fitness })], POLICY, 5000);
    expect(r.length).toBe(1);
    expect(r[0]?.reason).toContain("idle");
  });

  test("flags brick with success rate below threshold", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 2,
      errorCount: 18,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 100,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 20, fitness })], POLICY, 100);
    expect(r.length).toBe(1);
    expect(r[0]?.reason).toContain("success rate");
  });

  test("does not flag healthy brick", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 100,
      errorCount: 0,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 100,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 100, fitness })], POLICY, 100);
    expect(r).toEqual([]);
  });

  test("missing fitness on active brick surfaces as integrity (visibility for repair)", () => {
    // Missing fitness is observability failure, not evidence of idleness.
    // Surface as kind=integrity so callers can drive repair, but never
    // emit kind=retire so auto-apply paths cannot deprecate the brick.
    const r = suggestRetirement([tool({ id: "a", usageCount: 100 })], POLICY, 1_000_000);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
    expect(r[0]?.reason).toContain("missing fitness");
  });

  test("missing fitness + minSampleSize=0 does not produce NaN-rate auto-retire", () => {
    // Pre-fix bug: rate=NaN failed the `rate >= minSuccessRate` check,
    // producing a false retirement suggestion despite zero samples.
    const fitness: BrickFitnessMetrics = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 100,
    };
    const policy = { ...POLICY, minSampleSize: 0, minSuccessRate: 0.9 };
    const r = suggestRetirement([tool({ id: "a", usageCount: 100, fitness })], policy, 100);
    expect(r).toEqual([]);
  });

  test("ignores non-active bricks (retirement only narrows from active)", () => {
    const r = suggestRetirement(
      [tool({ id: "a", lifecycle: "deprecated", usageCount: 0 })],
      POLICY,
      0,
    );
    expect(r).toEqual([]);
  });

  test("skips success-rate check when sample size below minSampleSize", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 0,
      errorCount: 3,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 100,
    };
    // usageCount=10 >= minUsageCount=5; lastUsedAt=100 vs now=100 → not idle.
    // total samples (3) < minSampleSize (10) → success rate not evaluated.
    const r = suggestRetirement([tool({ id: "a", usageCount: 10, fitness })], POLICY, 100);
    expect(r).toEqual([]);
  });

  test("uses Date.now() when no `now` argument provided", () => {
    const r = suggestRetirement([tool({ id: "a", usageCount: 0 })], POLICY);
    expect(r.length).toBe(1);
  });

  test("uses fitness totals as fallback when usageCount is stale", () => {
    // Runtime telemetry (middleware-feedback-loop) updates `fitness` but not
    // `usageCount`. A healthy, frequently-used brick can therefore carry a
    // stale zero `usageCount`; retirement must not flag it.
    const fitness: BrickFitnessMetrics = {
      successCount: 100,
      errorCount: 0,
      latency: { samples: [10], count: 100, cap: 200 },
      lastUsedAt: 100,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 0, fitness })], POLICY, 100);
    expect(r).toEqual([]);
  });

  test("malformed fitness counters surface as integrity (not auto-retire on collapsed-to-zero usage)", () => {
    // Pre-fix bug: NaN counters silently collapsed to 0 via
    // safeNonNegativeInt, then `usage < minUsageCount` triggered an
    // auto-retire on a brick whose telemetry was simply corrupt.
    const fitness: BrickFitnessMetrics = {
      successCount: Number.NaN,
      errorCount: Number.NaN,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 100,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 0, fitness })], POLICY, 100);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
  });

  test("flags corrupt success/error counters in success-rate evaluation (does not silently bypass)", () => {
    // Pre-fix bug: NaN counters made `total` non-finite, so the
    // minSampleSize guard would skip success-rate checks entirely and let
    // a corrupted brick stay active.
    const fitness: BrickFitnessMetrics = {
      successCount: Number.POSITIVE_INFINITY,
      errorCount: 5,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 100,
    };
    const policyWithRate = { ...POLICY, minSuccessRate: 0.9, minSampleSize: 1 };
    const r = suggestRetirement([tool({ id: "a", usageCount: 100, fitness })], policyWithRate, 100);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
    expect(r[0]?.reason).toContain("corrupt");
  });

  test("clamps small future lastUsedAt to now (bounded clock skew, not corruption)", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 100,
      errorCount: 0,
      latency: { samples: [10], count: 100, cap: 200 },
      lastUsedAt: 10_000, // ahead of now=5_000 by 5s — within bounded skew
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 100, fitness })], POLICY, 5_000);
    expect(r).toEqual([]);
  });

  test("does not crash when fitness is null on an active brick (returns integrity finding)", () => {
    // Pre-fix bug: dereferencing fitness.successCount on a null fitness
    // threw and aborted the whole batch sweep, hiding every other brick's
    // retirement findings.
    // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
    const brick = tool({ id: "a", usageCount: 100, fitness: null as any });
    const r = suggestRetirement([brick], POLICY, 5_000);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
  });

  test("low-usage brick with corrupt lastUsedAt is integrity, not retire (telemetry failure ≠ idleness)", () => {
    // Pre-fix bug: low-usage retirement ran before the lastUsedAt
    // integrity check. A brick with NaN lastUsedAt and usage below
    // minUsageCount got auto-retired even though its recency telemetry
    // was unreadable — converting an observability failure into a
    // lifecycle action.
    const fitness: BrickFitnessMetrics = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: Number.NaN,
    };
    const policy = { ...POLICY, minUsageCount: 10 };
    const r = suggestRetirement([tool({ id: "a", usageCount: 0, fitness })], policy, 5_000);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
  });

  test("low-usage brick with far-future lastUsedAt is integrity, not retire", () => {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const fitness: BrickFitnessMetrics = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 5_000 + ONE_DAY_MS,
    };
    const policy = { ...POLICY, minUsageCount: 10 };
    const r = suggestRetirement([tool({ id: "a", usageCount: 0, fitness })], policy, 5_000);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
  });

  test("flags far-future lastUsedAt as integrity (cannot masquerade as fresh activity)", () => {
    // Pre-fix bug: any finite future timestamp clamped to `now`, so a
    // far-future stamp (wrong unit / wrong epoch / sign flip) was
    // converted into the strongest possible freshness signal — silently
    // suppressing idle retirement on a stale brick.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const fitness: BrickFitnessMetrics = {
      successCount: 100,
      errorCount: 0,
      latency: { samples: [10], count: 100, cap: 200 },
      lastUsedAt: 5_000 + ONE_DAY_MS, // 1 day in the future — far beyond any real skew
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 100, fitness })], POLICY, 5_000);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
    expect(r[0]?.reason).toContain("beyond now");
  });

  test("flags brick with non-finite lastUsedAt as integrity (not retirement)", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 100,
      errorCount: 0,
      latency: { samples: [10], count: 100, cap: 200 },
      lastUsedAt: Number.NaN,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 100, fitness })], POLICY, 5_000);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
    expect(r[0]?.reason).toContain("corrupt");
  });

  test("idle / low-usage / success-rate findings carry kind=retire", () => {
    const idle = suggestRetirement(
      [
        tool({
          id: "a",
          usageCount: 100,
          fitness: {
            successCount: 100,
            errorCount: 0,
            latency: { samples: [10], count: 100, cap: 200 },
            lastUsedAt: 0,
          },
        }),
      ],
      POLICY,
      1_000_000,
    );
    expect(idle[0]?.kind).toBe("retire");
    const low = suggestRetirement(
      [
        tool({
          id: "b",
          usageCount: 0,
          fitness: {
            successCount: 0,
            errorCount: 0,
            latency: { samples: [], count: 0, cap: 200 },
            lastUsedAt: 0,
          },
        }),
      ],
      POLICY,
      0,
    );
    expect(low[0]?.kind).toBe("retire");
  });

  test("corrupt usageCount surfaces as integrity (not auto-retire on collapsed-to-zero)", () => {
    const r = suggestRetirement([tool({ id: "a", usageCount: Number.NaN })], POLICY, 100);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
    expect(r[0]?.reason).toContain("usageCount");
  });

  test("fractional usageCount surfaces as integrity (partial-write detection)", () => {
    const r = suggestRetirement([tool({ id: "a", usageCount: 4.5 })], POLICY, 100);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
  });

  test("fractional fitness counters surface as integrity", () => {
    const fitness: BrickFitnessMetrics = {
      successCount: 0.5,
      errorCount: 5,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 100,
    };
    const r = suggestRetirement([tool({ id: "a", usageCount: 100, fitness })], POLICY, 100);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("integrity");
  });

  test("rejects malformed policy at API boundary (NaN minUsageCount)", () => {
    expect(() =>
      suggestRetirement(
        [tool({ id: "a", usageCount: 0 })],
        { ...POLICY, minUsageCount: Number.NaN },
        0,
      ),
    ).toThrow(TypeError);
  });

  test("rejects malformed policy at API boundary (negative maxIdleMs)", () => {
    expect(() =>
      suggestRetirement([tool({ id: "a", usageCount: 0 })], { ...POLICY, maxIdleMs: -1 }, 0),
    ).toThrow(TypeError);
  });

  test("rejects malformed policy at API boundary (minSuccessRate > 1)", () => {
    expect(() =>
      suggestRetirement([tool({ id: "a", usageCount: 0 })], { ...POLICY, minSuccessRate: 1.5 }, 0),
    ).toThrow(TypeError);
  });

  test("rejects malformed policy at API boundary (fractional minSampleSize)", () => {
    expect(() =>
      suggestRetirement([tool({ id: "a", usageCount: 0 })], { ...POLICY, minSampleSize: 1.5 }, 0),
    ).toThrow(TypeError);
  });

  test("rejects non-finite `now` (would silently disable idle retirement for every brick)", () => {
    expect(() =>
      suggestRetirement([tool({ id: "a", usageCount: 100 })], POLICY, Number.NaN),
    ).toThrow(TypeError);
  });

  test("returns multiple suggestions for multiple flagged bricks", () => {
    const r = suggestRetirement(
      [tool({ id: "a", usageCount: 0 }), tool({ id: "b", usageCount: 1 })],
      POLICY,
      0,
    );
    expect(r.length).toBe(2);
  });
});

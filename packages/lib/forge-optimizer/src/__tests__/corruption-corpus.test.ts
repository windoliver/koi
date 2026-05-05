/**
 * Corruption-corpus regression net.
 *
 * Enumerates every malformed shape the package defends against and runs
 * each public helper against every shape. Single broad guard against
 * regression: if a future change drops a fail-closed path, one of these
 * cases will throw or return a non-fail-closed value.
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickFitnessMetrics } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { computePerformanceScore } from "../performance.js";
import { suggestRetirement } from "../retirement.js";
import { suggestMerge, suggestSimplify } from "../suggestions.js";
import { detectFitnessIntegrity, recordUsage } from "../usage.js";

// biome-ignore lint/suspicious/noExplicitAny: corruption corpus by design uses malformed payloads
type Bad = any;

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

const CORRUPT_FITNESS: ReadonlyArray<{ name: string; value: Bad }> = [
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "primitive number", value: 0 },
  { name: "primitive string", value: "x" },
  { name: "array", value: [] },
  {
    name: "NaN counters",
    value: {
      successCount: Number.NaN,
      errorCount: Number.NaN,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 0,
    },
  },
  {
    name: "Infinity counters",
    value: {
      successCount: Number.POSITIVE_INFINITY,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 0,
    },
  },
  {
    name: "fractional counters",
    value: {
      successCount: 1.5,
      errorCount: 2.7,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 0,
    },
  },
  {
    name: "negative counters",
    value: {
      successCount: -5,
      errorCount: -1,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 0,
    },
  },
  {
    name: "NaN lastUsedAt",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: Number.NaN,
    },
  },
  {
    name: "negative lastUsedAt",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: -5,
    },
  },
  {
    name: "null latency",
    value: { successCount: 1, errorCount: 0, latency: null, lastUsedAt: 0 },
  },
  {
    name: "samples not array",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: "oops", count: 0, cap: 200 },
      lastUsedAt: 0,
    },
  },
  {
    name: "samples with NaN/Infinity/negative",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: {
        samples: [Number.NaN, Number.POSITIVE_INFINITY, -3, 5],
        count: 4,
        cap: 200,
      },
      lastUsedAt: 0,
    },
  },
  {
    name: "samples unsorted",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [5, 1, 3], count: 3, cap: 200 },
      lastUsedAt: 0,
    },
  },
  {
    name: "count smaller than samples.length",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [1, 2, 3], count: 1, cap: 200 },
      lastUsedAt: 0,
    },
  },
  {
    name: "samples larger than cap (oversized legacy)",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [1, 2, 3], count: 3, cap: 2 },
      lastUsedAt: 0,
    },
  },
  {
    name: "invalid cap (zero)",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 0 },
      lastUsedAt: 0,
    },
  },
  {
    name: "invalid cap (NaN)",
    value: {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: Number.NaN },
      lastUsedAt: 0,
    },
  },
  {
    name: "everything corrupt at once",
    value: {
      successCount: Number.NaN,
      errorCount: Number.POSITIVE_INFINITY,
      latency: { samples: "bad", count: -1, cap: 0 },
      lastUsedAt: Number.NEGATIVE_INFINITY,
    },
  },
];

function brick(fitness: Bad, overrides: Partial<BrickArtifact> = {}): BrickArtifact {
  return {
    id: "sha256:c" as BrickArtifact["id"],
    kind: "tool",
    name: "x",
    description: "",
    scope: "agent",
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: {} as BrickArtifact["provenance"],
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    implementation: "",
    inputSchema: {},
    fitness,
    ...overrides,
  } as BrickArtifact;
}

describe("corruption corpus — no helper throws on any malformed shape", () => {
  for (const { name, value } of CORRUPT_FITNESS) {
    describe(`fitness: ${name}`, () => {
      test("detectFitnessIntegrity does not throw", () => {
        expect(() => detectFitnessIntegrity(value)).not.toThrow();
      });

      test("computePerformanceScore does not throw and returns a finite non-negative number", () => {
        expect(() => computePerformanceScore(value as BrickFitnessMetrics, 1_000)).not.toThrow();
        const score = computePerformanceScore(value as BrickFitnessMetrics, 1_000);
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
      });

      test("recordUsage does not throw and produces a finite, non-negative-counter result", () => {
        expect(() =>
          recordUsage(value as BrickFitnessMetrics, { outcome: "success", latencyMs: 5, at: 1 }, 1),
        ).not.toThrow();
        const next = recordUsage(
          value as BrickFitnessMetrics,
          { outcome: "success", latencyMs: 5, at: 1 },
          1,
        );
        expect(Number.isInteger(next.successCount)).toBe(true);
        expect(Number.isInteger(next.errorCount)).toBe(true);
        expect(next.successCount).toBeGreaterThanOrEqual(0);
        expect(next.errorCount).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(next.lastUsedAt)).toBe(true);
        expect(next.lastUsedAt).toBeGreaterThanOrEqual(0);
        // Sampler invariants must be re-established after one event.
        expect(Array.isArray(next.latency.samples)).toBe(true);
        expect(next.latency.samples.length).toBeLessThanOrEqual(next.latency.cap);
        expect(next.latency.count).toBeGreaterThanOrEqual(next.latency.samples.length);
      });

      test("suggestRetirement does not throw on a brick carrying this fitness", () => {
        const b = brick(value);
        expect(() =>
          suggestRetirement([b], { minUsageCount: 1, maxIdleMs: 1_000 }, 5_000),
        ).not.toThrow();
      });

      test("suggestMerge does not throw and never throws on a malformed brick batch", () => {
        const b = brick(value);
        const b2 = brick(value, { id: "sha256:c2" as BrickArtifact["id"] });
        expect(() => suggestMerge([b, b2])).not.toThrow();
      });
    });
  }

  test("suggestSimplify does not throw on cyclic port schemas", () => {
    const port = { name: "p", schema: cyclic };
    const composite = {
      ...brick(undefined),
      kind: "composite" as const,
      steps: [
        {
          brickId: "sha256:s" as BrickArtifact["id"],
          inputPort: { name: "p", schema: {} },
          outputPort: { name: "p", schema: {} },
        },
      ],
      exposedInput: port,
      exposedOutput: port,
      outputKind: "tool" as const,
    } as unknown as BrickArtifact;
    expect(() => suggestSimplify(composite)).not.toThrow();
  });
});

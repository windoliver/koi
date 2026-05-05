import { describe, expect, test } from "bun:test";
import { DEFAULT_BRICK_FITNESS } from "@koi/core";
import { detectFitnessIntegrity, recordUsage } from "./usage.js";

const FAR_FUTURE = 10_000_000_000_000;

describe("recordUsage", () => {
  test("increments successCount on success outcome", () => {
    const next = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: 12, at: 1000 },
      1000,
    );
    expect(next.successCount).toBe(1);
    expect(next.errorCount).toBe(0);
  });

  test("increments errorCount on error outcome", () => {
    const next = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "error", latencyMs: 50, at: 2000 },
      2000,
    );
    expect(next.successCount).toBe(0);
    expect(next.errorCount).toBe(1);
  });

  test("updates lastUsedAt to event timestamp", () => {
    const next = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: 5, at: 9999 },
      9999,
    );
    expect(next.lastUsedAt).toBe(9999);
  });

  test("appends latency sample to bounded buffer", () => {
    const next = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: 42, at: 100 },
      100,
    );
    expect(next.latency.samples).toEqual([42]);
    expect(next.latency.count).toBe(1);
    expect(next.latency.cap).toBe(DEFAULT_BRICK_FITNESS.latency.cap);
  });

  test("sanitises legacy buffers containing NaN/Infinity before binary insert", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: {
        samples: [5, Number.NaN, 1, Number.POSITIVE_INFINITY, -2],
        count: 5,
        cap: 200,
      },
      lastUsedAt: 0,
    } as const;
    const next = recordUsage(seed, { outcome: "success", latencyMs: 3, at: 1 }, 1);
    for (const s of next.latency.samples) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < next.latency.samples.length; i++) {
      expect(next.latency.samples[i]).toBeGreaterThanOrEqual(next.latency.samples[i - 1] ?? 0);
    }
  });

  test("normalises a legacy unsorted latency buffer before delegating to recordLatency", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [5, 1, 3], count: 3, cap: 200 }, // legacy FIFO
      lastUsedAt: 0,
    } as const;
    const next = recordUsage(seed, { outcome: "success", latencyMs: 2, at: 1 }, 1);
    // Result must be ascending — required by recordLatency / computePercentile.
    for (let i = 1; i < next.latency.samples.length; i++) {
      expect(next.latency.samples[i]).toBeGreaterThanOrEqual(next.latency.samples[i - 1] ?? 0);
    }
    expect(next.latency.samples).toContain(2);
  });

  test("keeps the buffer sorted ascending and bumps count", () => {
    let s = recordUsage(DEFAULT_BRICK_FITNESS, { outcome: "success", latencyMs: 3, at: 1 }, 1);
    s = recordUsage(s, { outcome: "success", latencyMs: 1, at: 2 }, 2);
    s = recordUsage(s, { outcome: "success", latencyMs: 2, at: 3 }, 3);
    expect(s.latency.samples).toEqual([1, 2, 3]);
    expect(s.latency.count).toBe(3);
  });

  test("is fully deterministic at and beyond cap (replay-safe — no Math.random)", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [1, 2, 3], count: 3, cap: 3 },
      lastUsedAt: 0,
    } as const;
    const a = recordUsage(seed, { outcome: "success", latencyMs: 4, at: 1 }, 1);
    const b = recordUsage(seed, { outcome: "success", latencyMs: 4, at: 1 }, 1);
    expect(a.latency.samples).toEqual(b.latency.samples);
    expect(a.latency.samples.length).toBe(3);
    expect(a.latency.count).toBe(4);
    // Result must remain ascending whether the reservoir kept or rejected
    // the new sample.
    for (let i = 1; i < a.latency.samples.length; i++) {
      expect(a.latency.samples[i]).toBeGreaterThanOrEqual(a.latency.samples[i - 1] ?? 0);
    }
  });

  test("approximates a uniform reservoir over a long stream (no extreme bias)", () => {
    // Feed 10_000 increasing latencies (1..10_000) into a cap=200 buffer.
    // A representative sample's mean should land near the population
    // mean (~5000); a biased-toward-extremes sample would skew far off.
    let s = recordUsage(DEFAULT_BRICK_FITNESS, { outcome: "success", latencyMs: 1, at: 1 }, 1);
    for (let i = 2; i <= 10_000; i++) {
      s = recordUsage(s, { outcome: "success", latencyMs: i, at: i }, i);
    }
    expect(s.latency.samples.length).toBe(s.latency.cap);
    expect(s.latency.count).toBe(10_000);
    const sum = s.latency.samples.reduce((a, v) => a + v, 0);
    const mean = sum / s.latency.samples.length;
    // Population mean is 5000.5; allow ±25% (~1250) for a small reservoir.
    expect(mean).toBeGreaterThan(3750);
    expect(mean).toBeLessThan(6250);
  });

  test("does not mutate input fitness", () => {
    const before = DEFAULT_BRICK_FITNESS;
    const beforeSamples = before.latency.samples;
    recordUsage(before, { outcome: "success", latencyMs: 7, at: 1 }, 1);
    expect(before.successCount).toBe(0);
    expect(before.latency.samples).toBe(beforeSamples);
  });

  test("invalid-latency event still heals an already-corrupt sampler", () => {
    // Pre-fix bug: invalid latency skipped append AND skipped healing,
    // so a malformed producer + corrupt sampler stayed corrupt forever.
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [5, Number.NaN, 1, -2], count: 4, cap: 200 },
      lastUsedAt: 0,
    };
    const next = recordUsage(seed, { outcome: "success", latencyMs: Number.NaN, at: 1 }, 1);
    // Sampler must be sanitised + sorted on skip path too.
    for (const s of next.latency.samples) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < next.latency.samples.length; i++) {
      expect(next.latency.samples[i]).toBeGreaterThanOrEqual(next.latency.samples[i - 1] ?? 0);
    }
  });

  test("skips invalid (NaN) latency from reservoir but still advances counter", () => {
    // Pre-fix bug: NaN clamped to 0, then 0 ≈ best-case latency in scoring.
    const next = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: Number.NaN, at: 1 },
      1,
    );
    expect(next.latency.samples).toEqual([]);
    expect(next.successCount).toBe(1);
  });

  test("preserves monotonic lastUsedAt when an older event arrives after a newer one", () => {
    const newer = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: 10, at: 1_000 },
      1_000,
    );
    const older = recordUsage(newer, { outcome: "success", latencyMs: 10, at: 500 }, 1_000);
    expect(older.lastUsedAt).toBe(1_000);
  });

  test("future-dated event clamps to ingestNow and advances recency", () => {
    // Counters and latency advance for every event, so leaving recency
    // at `prior` would let a stream of future-stamped events flow through
    // recordUsage while suggestRetirement later marks the brick idle.
    // Clamp to ingestNow so recency tracks real ingest activity.
    const seed = { ...DEFAULT_BRICK_FITNESS, lastUsedAt: 1_000 };
    const out = recordUsage(seed, { outcome: "success", latencyMs: 10, at: FAR_FUTURE }, 5_000);
    expect(out.lastUsedAt).toBe(5_000);
  });

  test("a stream of future-dated events does not let an actively-used brick look idle", () => {
    // Regression: prior implementation returned `prior` on future events.
    // suggestRetirement would then trip `idleMs > maxIdleMs` even though
    // recordUsage was being called for real traffic. Clamping to ingestNow
    // keeps recency in step with ingest activity.
    let s = { ...DEFAULT_BRICK_FITNESS, lastUsedAt: 0 };
    for (let i = 1; i <= 100; i++) {
      s = recordUsage(s, { outcome: "success", latencyMs: 5, at: FAR_FUTURE }, i * 1_000);
    }
    expect(s.lastUsedAt).toBe(100_000);
    expect(s.successCount).toBe(100);
  });

  test("is deterministic: replaying the same event with the same ingestNow yields the same lastUsedAt", () => {
    const ingestNow = 5_000;
    const a = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: 10, at: 4_000 },
      ingestNow,
    );
    const b = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: 10, at: 4_000 },
      ingestNow,
    );
    expect(a.lastUsedAt).toBe(b.lastUsedAt);
  });

  test("throws TypeError when event.at is non-finite", () => {
    expect(() =>
      recordUsage(
        DEFAULT_BRICK_FITNESS,
        { outcome: "success", latencyMs: 10, at: Number.NaN },
        5_000,
      ),
    ).toThrow(TypeError);
  });

  test("throws TypeError when ingestNow is non-finite (e.g. legacy 2-arg JS caller)", () => {
    expect(() =>
      recordUsage(
        DEFAULT_BRICK_FITNESS,
        { outcome: "success", latencyMs: 10, at: 5_000 },
        Number.NaN,
      ),
    ).toThrow(TypeError);
  });

  test("heals corrupt prior successCount (NaN) and keeps telemetry advancing", () => {
    // Pre-fix bug: throwing on corrupt counters froze every subsequent
    // event for the brick. Heal silently so the stream keeps moving;
    // the integrity signal is preserved via `detectFitnessIntegrity`.
    const seed = {
      successCount: Number.NaN,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 0,
    };
    const next = recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1);
    expect(next.successCount).toBe(1);
    expect(next.errorCount).toBe(0);
  });

  test("heals fractional / negative / Infinity prior counters", () => {
    const cases = [
      { successCount: 1.5, errorCount: 0 },
      { successCount: 0, errorCount: -3 },
      { successCount: 0, errorCount: Number.POSITIVE_INFINITY },
    ];
    for (const c of cases) {
      const seed = { ...c, latency: { samples: [], count: 0, cap: 200 }, lastUsedAt: 0 };
      const next = recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1);
      expect(Number.isInteger(next.successCount)).toBe(true);
      expect(Number.isInteger(next.errorCount)).toBe(true);
      expect(next.successCount).toBeGreaterThanOrEqual(0);
      expect(next.errorCount).toBeGreaterThanOrEqual(0);
    }
  });

  test("repeated events against an already-corrupt fitness keep advancing (no telemetry freeze)", () => {
    const seed = {
      successCount: Number.NaN,
      errorCount: Number.POSITIVE_INFINITY,
      latency: { samples: [] as readonly number[], count: 0, cap: 200 },
      lastUsedAt: 0,
    };
    let s = recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1);
    for (let i = 2; i <= 10; i++) {
      s = recordUsage(s, { outcome: "success", latencyMs: 5, at: i }, i);
    }
    expect(s.successCount).toBe(10);
    expect(s.errorCount).toBe(0);
    expect(s.lastUsedAt).toBe(10);
  });

  test("emits integrity event via onIntegrity callback when healing corrupt counters", () => {
    const seed = {
      successCount: Number.NaN,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: 0,
    };
    const events: { field: string; reason: string }[] = [];
    const next = recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1, (issue) =>
      events.push({ field: issue.field, reason: issue.reason }),
    );
    expect(next.successCount).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.field).toBe("successCount");
  });

  test("does not emit integrity event when prior fitness is clean", () => {
    const events: { field: string }[] = [];
    recordUsage(DEFAULT_BRICK_FITNESS, { outcome: "success", latencyMs: 5, at: 1 }, 1, (issue) =>
      events.push({ field: issue.field }),
    );
    expect(events).toEqual([]);
  });

  describe("detectFitnessIntegrity", () => {
    const ok = {
      successCount: 1,
      errorCount: 0,
      latency: { samples: [10], count: 1, cap: 200 },
      lastUsedAt: 1,
    };

    test("returns empty array for a clean snapshot", () => {
      expect(detectFitnessIntegrity(ok)).toEqual([]);
    });

    test("flags NaN successCount", () => {
      const r = detectFitnessIntegrity({ ...ok, successCount: Number.NaN });
      expect(r[0]?.field).toBe("successCount");
    });

    test("flags fractional errorCount", () => {
      const r = detectFitnessIntegrity({ ...ok, errorCount: 1.5 });
      expect(r[0]?.field).toBe("errorCount");
    });

    test("flags non-finite lastUsedAt", () => {
      const r = detectFitnessIntegrity({ ...ok, lastUsedAt: Number.NaN });
      expect(r[0]?.field).toBe("lastUsedAt");
    });

    test("flags missing latency sampler", () => {
      // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
      const bad: any = { ...ok, latency: null };
      const r = detectFitnessIntegrity(bad);
      expect(r[0]?.field).toBe("latency");
    });

    test("flags wrong-typed latency.samples (not an array)", () => {
      // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
      const bad: any = { ...ok, latency: { samples: "oops", count: 0, cap: 200 } };
      expect(detectFitnessIntegrity(bad)[0]?.field).toBe("latency");
    });

    test("flags non-finite values inside latency.samples", () => {
      const bad = { ...ok, latency: { samples: [1, Number.NaN, 5], count: 3, cap: 200 } };
      expect(detectFitnessIntegrity(bad)[0]?.field).toBe("latency");
    });

    test("flags unsorted latency.samples", () => {
      const bad = { ...ok, latency: { samples: [5, 1, 3], count: 3, cap: 200 } };
      expect(detectFitnessIntegrity(bad)[0]?.field).toBe("latency");
    });

    test("flags non-integer / NaN latency.count", () => {
      const bad = { ...ok, latency: { samples: [1], count: Number.NaN, cap: 200 } };
      expect(detectFitnessIntegrity(bad)[0]?.field).toBe("latency");
      const fractional = { ...ok, latency: { samples: [1], count: 1.5, cap: 200 } };
      expect(detectFitnessIntegrity(fractional)[0]?.field).toBe("latency");
    });

    test("flags latency.count smaller than samples.length", () => {
      const bad = { ...ok, latency: { samples: [1, 2, 3], count: 1, cap: 200 } };
      expect(detectFitnessIntegrity(bad)[0]?.field).toBe("latency");
    });

    test("flags invalid latency.cap (zero, negative, non-integer)", () => {
      for (const cap of [0, -1, 1.5, Number.NaN]) {
        const bad = { ...ok, latency: { samples: [], count: 0, cap } };
        expect(detectFitnessIntegrity(bad)[0]?.field).toBe("latency");
      }
    });

    test("flags samples buffer larger than cap (legacy oversized record)", () => {
      const bad = { ...ok, latency: { samples: [1, 2, 3], count: 3, cap: 2 } };
      expect(detectFitnessIntegrity(bad)[0]?.field).toBe("latency");
    });

    test("returns ALL issues when multiple fields are corrupt (multi-issue surface)", () => {
      const bad = {
        successCount: Number.NaN,
        errorCount: 1.5,
        latency: { samples: [], count: 0, cap: 0 },
        lastUsedAt: Number.NaN,
      };
      const issues = detectFitnessIntegrity(bad);
      const fields = issues.map((i) => i.field).sort();
      expect(fields).toEqual(["errorCount", "lastUsedAt", "latency", "successCount"]);
    });

    test("does not throw on null / primitive / array fitness — returns integrity issue", () => {
      for (const bad of [null, 0, "x", []]) {
        // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
        expect(() => detectFitnessIntegrity(bad as any)).not.toThrow();
        // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
        const issues = detectFitnessIntegrity(bad as any);
        expect(issues.length).toBeGreaterThan(0);
      }
    });
  });

  test("recordUsage does not throw on null fitness — heals from default skeleton", () => {
    // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
    const next = recordUsage(null as any, { outcome: "success", latencyMs: 5, at: 1 }, 1);
    expect(next.successCount).toBe(1);
    expect(next.errorCount).toBe(0);
    expect(next.latency.samples).toEqual([5]);
    expect(next.lastUsedAt).toBe(1);
  });

  test("recordUsage emits ALL integrity events from a multi-corrupt prior fitness", () => {
    const seed = {
      successCount: Number.NaN,
      errorCount: 1.5,
      latency: { samples: [], count: 0, cap: 0 },
      lastUsedAt: Number.NaN,
    };
    const events: string[] = [];
    recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1, (issue) =>
      events.push(issue.field),
    );
    expect(events.sort()).toEqual(["errorCount", "lastUsedAt", "latency", "successCount"]);
  });

  test("heals NaN prior lastUsedAt instead of perpetuating Math.max(NaN, x) = NaN", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: Number.NaN,
    };
    const next = recordUsage(seed, { outcome: "success", latencyMs: 1, at: 5_000 }, 5_000);
    expect(Number.isFinite(next.lastUsedAt)).toBe(true);
    expect(next.lastUsedAt).toBe(5_000);
  });

  test("heal preserves count >= base.length so reservoir math stays bounded", () => {
    // Pre-fix bug: persisted record with count smaller than buffer (or
    // wrong-typed count coerced to 0) made post-cap probability cap/N > 1
    // and caused unconditional replacement until count caught up.
    const seed = {
      successCount: 0,
      errorCount: 0,
      // biome-ignore lint/suspicious/noExplicitAny: simulating wrong-typed count
      latency: { samples: [1, 2, 3], count: "bogus" as any, cap: 5 },
      lastUsedAt: 0,
    };
    const next = recordUsage(seed, { outcome: "success", latencyMs: 4, at: 1 }, 1);
    expect(Number.isInteger(next.latency.count)).toBe(true);
    expect(next.latency.count).toBeGreaterThanOrEqual(next.latency.samples.length);
  });

  test("heals NaN latency.count from buffer length so reservoir math stays finite", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [1, 2, 3], count: Number.NaN, cap: 5 },
      lastUsedAt: 0,
    };
    const next = recordUsage(seed, { outcome: "success", latencyMs: 4, at: 1 }, 1);
    expect(Number.isFinite(next.latency.count)).toBe(true);
    expect(Number.isInteger(next.latency.count)).toBe(true);
  });

  test("normalises cap=0 to a finite cap >= 1", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [], count: 0, cap: 0 },
      lastUsedAt: 0,
    } as const;
    const next = recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1);
    expect(next.latency.cap).toBeGreaterThanOrEqual(1);
    expect(next.latency.samples.length).toBeLessThanOrEqual(next.latency.cap);
  });

  test("normalises cap=NaN to a finite cap >= 1 and stays bounded", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [1, 2, 3], count: 3, cap: Number.NaN },
      lastUsedAt: 0,
    } as const;
    let s = recordUsage(seed, { outcome: "success", latencyMs: 4, at: 1 }, 1);
    for (let i = 0; i < 20; i++) {
      s = recordUsage(s, { outcome: "success", latencyMs: i, at: i + 2 }, i + 2);
    }
    expect(Number.isFinite(s.latency.cap)).toBe(true);
    expect(s.latency.cap).toBeGreaterThanOrEqual(1);
    expect(s.latency.samples.length).toBeLessThanOrEqual(s.latency.cap);
  });

  test("trims oversized legacy buffer down to the effective cap", () => {
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], count: 10, cap: 3 },
      lastUsedAt: 0,
    } as const;
    const next = recordUsage(seed, { outcome: "success", latencyMs: 0, at: 1 }, 1);
    expect(next.latency.samples.length).toBeLessThanOrEqual(next.latency.cap);
    expect(next.latency.cap).toBe(3);
  });

  test("oversized-buffer downsample with cap=1 retains the median, not the minimum", () => {
    // Pre-fix bug: cap=1 always kept sorted[0] (the fastest sample), so a
    // legacy [5, 50, 500] would heal to [5] and rank the brick as extremely
    // fast despite arbitrary corruption. Median preserves central tendency.
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: [5, 50, 500], count: 3, cap: 1 },
      lastUsedAt: 0,
    } as const;
    // Use latency=500 (no insert into healed buffer at cap=1 since reservoir
    // decision is deterministic — verify the healed base before insert).
    // Easier: heal via a pure call by feeding a sample that the reservoir
    // rejects, then check the result still includes a representative value.
    const next = recordUsage(seed, { outcome: "success", latencyMs: 500, at: 1 }, 1);
    expect(next.latency.cap).toBe(1);
    expect(next.latency.samples.length).toBe(1);
    // Median of [5, 50, 500] is 50; the result must NOT be just the minimum (5).
    const v = next.latency.samples[0] ?? 0;
    expect(v).toBeGreaterThan(5);
  });

  test("oversized-buffer downsample preserves the slow tail (does not bias scoring)", () => {
    // Pre-fix bug: slice(0, cap) kept only [1..cap] and discarded the slow
    // tail, making the brick look ~cap/2 ms instead of ~50ms on average.
    const seed = {
      successCount: 0,
      errorCount: 0,
      latency: { samples: Array.from({ length: 100 }, (_, i) => i + 1), count: 100, cap: 5 },
      lastUsedAt: 0,
    } as const;
    const next = recordUsage(seed, { outcome: "success", latencyMs: 50, at: 1 }, 1);
    expect(next.latency.samples.length).toBeLessThanOrEqual(next.latency.cap);
    // The retained samples must include something from the slow tail.
    const max = Math.max(...next.latency.samples);
    expect(max).toBeGreaterThan(50);
  });

  test("heals wrong-shaped persisted latency sampler instead of crashing", () => {
    // Pre-fix bug: deserialized JSON missing `samples`/`count`/`cap` would
    // crash `recordUsage`, freezing telemetry for that brick until manual
    // repair. Heal at the boundary so future events still advance.
    const seed = {
      successCount: 0,
      errorCount: 0,
      // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
      latency: { samples: null, count: "bogus", cap: undefined } as any,
      lastUsedAt: 0,
    };
    expect(() => recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1)).not.toThrow();
    const next = recordUsage(seed, { outcome: "success", latencyMs: 5, at: 1 }, 1);
    expect(next.successCount).toBe(1);
    expect(Array.isArray(next.latency.samples)).toBe(true);
    expect(next.latency.samples.length).toBeGreaterThan(0);
  });

  test("throws TypeError for unknown event.outcome (runtime guard for JS callers)", () => {
    expect(() =>
      recordUsage(
        DEFAULT_BRICK_FITNESS,
        // biome-ignore lint/suspicious/noExplicitAny: testing JS caller passing arbitrary outcome
        { outcome: "unknown" as any, latencyMs: 5, at: 1 },
        1,
      ),
    ).toThrow(TypeError);
  });

  test("skips negative latency from reservoir (does not pollute with 0)", () => {
    const next = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: -5, at: 1 },
      1,
    );
    expect(next.latency.samples).toEqual([]);
  });
});

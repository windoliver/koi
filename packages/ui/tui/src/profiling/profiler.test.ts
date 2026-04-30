import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bumpCounter,
  dumpProfile,
  isProfilingEnabled,
  recordHistogram,
  resetProfiler,
} from "./profiler.js";

describe("profiler", () => {
  beforeEach(() => {
    resetProfiler({ enabled: true });
  });

  afterEach(() => {
    resetProfiler({ enabled: false });
  });

  describe("when disabled", () => {
    test("isProfilingEnabled returns false", () => {
      resetProfiler({ enabled: false });
      expect(isProfilingEnabled()).toBe(false);
    });

    test("bumpCounter is a no-op", () => {
      resetProfiler({ enabled: false });
      bumpCounter("a");
      bumpCounter("a");
      const report = dumpProfile();
      expect(report.counters).toEqual({});
    });

    test("recordHistogram is a no-op", () => {
      resetProfiler({ enabled: false });
      recordHistogram("h", 100);
      const report = dumpProfile();
      expect(report.histograms).toEqual({});
    });
  });

  describe("when enabled", () => {
    test("isProfilingEnabled returns true", () => {
      expect(isProfilingEnabled()).toBe(true);
    });

    test("bumpCounter accumulates by 1 by default", () => {
      bumpCounter("renders");
      bumpCounter("renders");
      bumpCounter("renders");
      const report = dumpProfile();
      expect(report.counters.renders).toBe(3);
    });

    test("bumpCounter accepts custom increment", () => {
      bumpCounter("bytes", 100);
      bumpCounter("bytes", 50);
      const report = dumpProfile();
      expect(report.counters.bytes).toBe(150);
    });

    test("bumpCounter tracks multiple counters independently", () => {
      bumpCounter("a");
      bumpCounter("b", 5);
      bumpCounter("a");
      const report = dumpProfile();
      expect(report.counters).toEqual({ a: 2, b: 5 });
    });

    test("recordHistogram captures values and computes summary", () => {
      for (let i = 1; i <= 100; i++) recordHistogram("latency", i);
      const report = dumpProfile();
      const h = report.histograms.latency;
      expect(h).toBeDefined();
      if (!h) return;
      expect(h.count).toBe(100);
      expect(h.min).toBe(1);
      expect(h.max).toBe(100);
      expect(h.mean).toBeCloseTo(50.5, 1);
      // nearest-rank percentile on [1..100]: p50 = 50, p95 = 95, p99 = 99
      expect(h.p50).toBe(50);
      expect(h.p95).toBe(95);
      expect(h.p99).toBe(99);
    });

    test("recordHistogram handles single value", () => {
      recordHistogram("once", 42);
      const report = dumpProfile();
      const h = report.histograms.once;
      expect(h).toBeDefined();
      if (!h) return;
      expect(h.count).toBe(1);
      expect(h.min).toBe(42);
      expect(h.max).toBe(42);
      expect(h.p50).toBe(42);
      expect(h.p95).toBe(42);
      expect(h.p99).toBe(42);
    });

    test("dumpProfile is a snapshot — does not clear state", () => {
      bumpCounter("x");
      const r1 = dumpProfile();
      const r2 = dumpProfile();
      expect(r1.counters.x).toBe(1);
      expect(r2.counters.x).toBe(1);
    });
  });

  describe("resetProfiler", () => {
    test("clears counters and histograms", () => {
      bumpCounter("a");
      recordHistogram("h", 1);
      resetProfiler({ enabled: true });
      const report = dumpProfile();
      expect(report.counters).toEqual({});
      expect(report.histograms).toEqual({});
    });

    test("toggles enabled state", () => {
      expect(isProfilingEnabled()).toBe(true);
      resetProfiler({ enabled: false });
      expect(isProfilingEnabled()).toBe(false);
      resetProfiler({ enabled: true });
      expect(isProfilingEnabled()).toBe(true);
    });

    test("env-driven default uses KOI_TUI_PROFILE", () => {
      const prev = process.env.KOI_TUI_PROFILE;
      process.env.KOI_TUI_PROFILE = "1";
      resetProfiler();
      expect(isProfilingEnabled()).toBe(true);

      process.env.KOI_TUI_PROFILE = "0";
      resetProfiler();
      expect(isProfilingEnabled()).toBe(false);

      delete process.env.KOI_TUI_PROFILE;
      resetProfiler();
      expect(isProfilingEnabled()).toBe(false);

      if (prev !== undefined) process.env.KOI_TUI_PROFILE = prev;
    });
  });
});

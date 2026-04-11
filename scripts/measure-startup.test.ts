/**
 * Unit tests for pure helpers in measure-startup.ts.
 *
 * Does not exercise Bun.spawnSync — that path is end-to-end tested by the
 * CI gate itself. These tests cover: stats computation, three-condition
 * gate logic (hard ceiling, p50 drift, p90 drift, absolute floor vs
 * multiplicative), environment detection, flag parsing, and report
 * formatting.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Baseline,
  type BaselineScenario,
  compareAgainst,
  computeStats,
  detectEnvironment,
  environmentMatches,
  formatReport,
  P50_PCT_TOLERANCE,
  P90_PCT_TOLERANCE,
  parseFlags,
  refHasBaselineFile,
  type Scenario,
  validateBaselineSchema,
} from "./measure-startup.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

const SCENARIO: Scenario = {
  name: "fast-path",
  description: "test",
  argv: ["--version"],
  env: {},
  budgetMs: 250,
  absSlopMs: 50,
};

describe("computeStats", () => {
  test("single sample: all stats equal the value", () => {
    const s = computeStats([42]);
    expect(s).toEqual({ p50: 42, p90: 42, mean: 42, min: 42, max: 42, samples: 1 });
  });

  test("sorted input: p50/p90 use nearest-rank percentile", () => {
    // n=10, sorted 1..10. Nearest-rank: p50 = index ceil(5)-1 = 4 → value 5;
    // p90 = index ceil(9)-1 = 8 → value 9.
    const s = computeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.p50).toBe(5);
    expect(s.p90).toBe(9);
    expect(s.mean).toBe(5.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.samples).toBe(10);
  });

  test("unsorted input is sorted internally", () => {
    const s = computeStats([10, 1, 5, 3, 7]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
  });

  test("throws on empty input", () => {
    expect(() => computeStats([])).toThrow();
  });
});

describe("compareAgainst", () => {
  test("passes when under hard ceiling and no baseline", () => {
    const stats = { p50: 100, p90: 150, mean: 110, min: 80, max: 200, samples: 20 };
    const r = compareAgainst("fast-path", stats, undefined, SCENARIO);
    expect(r.pass).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("fails on hard-ceiling violation (p50 over budget)", () => {
    const stats = { p50: 300, p90: 320, mean: 310, min: 280, max: 340, samples: 20 };
    const r = compareAgainst("fast-path", stats, undefined, SCENARIO);
    expect(r.pass).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    expect(r.violations[0]?.rule).toBe("hard-ceiling (p50)");
  });

  test("passes when within multiplicative drift tolerance on p50", () => {
    // baseline.p50 = 100 → limit = max(100+50, 100*1.20) = 150
    const baseline: BaselineScenario = {
      p50: 100,
      p90: 120,
      mean: 105,
      min: 90,
      max: 130,
      samples: 20,
    };
    const stats = { p50: 149, p90: 144, mean: 130, min: 110, max: 160, samples: 20 };
    const r = compareAgainst("fast-path", stats, baseline, SCENARIO);
    expect(r.pass).toBe(true);
  });

  test("fails on p50 drift (exceeds max of abs and pct)", () => {
    const baseline: BaselineScenario = {
      p50: 100,
      p90: 120,
      mean: 105,
      min: 90,
      max: 130,
      samples: 20,
    };
    // 151 > max(150, 120) → drift (p50)
    const stats = { p50: 151, p90: 140, mean: 130, min: 110, max: 160, samples: 20 };
    const r = compareAgainst("fast-path", stats, baseline, SCENARIO);
    expect(r.pass).toBe(false);
    const p50Violation = r.violations.find((v) => v.rule === "drift (p50)");
    expect(p50Violation).toBeDefined();
  });

  test("absolute floor prevents tiny slack on fast baselines", () => {
    // baseline.p50 = 20 (fast). Multiplicative would give 24ms limit (4ms slack).
    // Absolute floor = 20 + 50 = 70 — this is what applies.
    const baseline: BaselineScenario = {
      p50: 20,
      p90: 25,
      mean: 21,
      min: 18,
      max: 30,
      samples: 20,
    };
    // 60ms — well over multiplicative limit (24) but under absolute floor (70)
    const stats = { p50: 60, p90: 62, mean: 61, min: 55, max: 70, samples: 20 };
    const r = compareAgainst("fast-path", stats, baseline, SCENARIO);
    expect(r.pass).toBe(true);
  });

  test("fails on p90 drift even when p50 passes", () => {
    // baseline.p90 = 100 → limit = max(100+50, 100*1.25) = 150
    const baseline: BaselineScenario = {
      p50: 80,
      p90: 100,
      mean: 85,
      min: 70,
      max: 110,
      samples: 20,
    };
    const stats = { p50: 85, p90: 160, mean: 100, min: 70, max: 180, samples: 20 };
    const r = compareAgainst("fast-path", stats, baseline, SCENARIO);
    expect(r.pass).toBe(false);
    const p90Violation = r.violations.find((v) => v.rule === "drift (p90)");
    expect(p90Violation).toBeDefined();
  });

  test("tolerance constants are the values documented in the plan", () => {
    expect(P50_PCT_TOLERANCE).toBe(1.2);
    expect(P90_PCT_TOLERANCE).toBe(1.25);
  });
});

describe("detectEnvironment", () => {
  test("local when GITHUB_ACTIONS is not set", () => {
    const env = detectEnvironment({});
    expect(env.runner).toBe("local");
  });

  test("github-actions when GITHUB_ACTIONS=true", () => {
    const env = detectEnvironment({
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
    });
    expect(env.runner).toBe("github-actions/Linux/X64");
  });

  test("records bun version and arch", () => {
    const env = detectEnvironment({});
    expect(env.bun.length).toBeGreaterThan(0);
    expect(env.arch.length).toBeGreaterThan(0);
  });
});

describe("environmentMatches", () => {
  test("true when all fields match", () => {
    const a = { runner: "r", bun: "1.3.7", arch: "x64" };
    const b = { runner: "r", bun: "1.3.7", arch: "x64" };
    expect(environmentMatches(a, b)).toBe(true);
  });

  test("false when bun version differs", () => {
    const a = { runner: "r", bun: "1.3.7", arch: "x64" };
    const b = { runner: "r", bun: "1.3.8", arch: "x64" };
    expect(environmentMatches(a, b)).toBe(false);
  });
});

describe("parseFlags", () => {
  test("defaults", () => {
    const f = parseFlags([]);
    expect(f.local).toBe(false);
    expect(f.updateBaseline).toBe(false);
    expect(f.json).toBe(false);
    expect(f.samples).toBe(20);
    expect(f.baselineRef).toBeUndefined();
    expect(f.allowMigration).toBe(false);
  });

  test("--allow-migration flag", () => {
    const f = parseFlags(["--allow-migration"]);
    expect(f.allowMigration).toBe(true);
  });

  test("--bootstrap-completion flag", () => {
    const f = parseFlags(["--bootstrap-completion"]);
    expect(f.bootstrapCompletion).toBe(true);
  });

  test("--warn-only flag", () => {
    const f = parseFlags(["--warn-only"]);
    expect(f.warnOnly).toBe(true);
  });

  test("defaults: bootstrap-completion and warn-only are off", () => {
    const f = parseFlags([]);
    expect(f.bootstrapCompletion).toBe(false);
    expect(f.warnOnly).toBe(false);
  });

  test("--local --json --update-baseline", () => {
    const f = parseFlags(["--local", "--json", "--update-baseline"]);
    expect(f.local).toBe(true);
    expect(f.json).toBe(true);
    expect(f.updateBaseline).toBe(true);
  });

  test("--samples N", () => {
    const f = parseFlags(["--samples", "30"]);
    expect(f.samples).toBe(30);
  });

  test("--baseline-ref origin/main", () => {
    const f = parseFlags(["--baseline-ref", "origin/main"]);
    expect(f.baselineRef).toBe("origin/main");
  });

  test("--baseline-ref without value throws", () => {
    expect(() => parseFlags(["--baseline-ref"])).toThrow();
  });

  test("--samples without value throws", () => {
    expect(() => parseFlags(["--samples"])).toThrow();
  });

  test("--samples with non-integer throws", () => {
    expect(() => parseFlags(["--samples", "abc"])).toThrow();
  });

  test("--samples below minimum throws", () => {
    expect(() => parseFlags(["--samples", "2"])).toThrow();
  });

  test("unknown flag throws", () => {
    expect(() => parseFlags(["--no-such-flag"])).toThrow();
  });
});

describe("validateBaselineSchema", () => {
  const scenarios: readonly Scenario[] = [
    {
      name: "a",
      description: "a",
      argv: ["--version"],
      env: {},
      budgetMs: 100,
      absSlopMs: 50,
    },
    {
      name: "b",
      description: "b",
      argv: ["--version"],
      env: {},
      budgetMs: 100,
      absSlopMs: 50,
    },
  ];

  const goodEntry: BaselineScenario = {
    p50: 10,
    p90: 15,
    mean: 11,
    min: 9,
    max: 20,
    samples: 20,
  };

  function baseline(scenarios: Record<string, BaselineScenario>): Baseline {
    return {
      generatedAt: "2026-04-09T00:00:00Z",
      environment: { runner: "r", bun: "1.3.9", arch: "x64" },
      scenarios,
    };
  }

  test("OK when every scenario has a complete entry", () => {
    const b = baseline({ a: goodEntry, b: goodEntry });
    expect(validateBaselineSchema(b, scenarios)).toEqual([]);
  });

  test("fails loud on missing scenario entry", () => {
    const b = baseline({ a: goodEntry });
    const errs = validateBaselineSchema(b, scenarios);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('"b"'))).toBe(true);
  });

  test("fails loud on unknown scenario in baseline (drift/rename)", () => {
    const b = baseline({ a: goodEntry, b: goodEntry, stale: goodEntry });
    const errs = validateBaselineSchema(b, scenarios);
    expect(errs.some((e) => e.includes('"stale"'))).toBe(true);
  });

  test("fails loud on non-finite stat field", () => {
    const broken: BaselineScenario = { ...goodEntry, p90: Number.NaN };
    const b = baseline({ a: goodEntry, b: broken });
    const errs = validateBaselineSchema(b, scenarios);
    expect(errs.some((e) => e.includes("p90"))).toBe(true);
  });

  test("fails loud on wrong type for a stat field", () => {
    const broken = { ...goodEntry, min: "nope" as unknown as number };
    const b = baseline({ a: goodEntry, b: broken });
    const errs = validateBaselineSchema(b, scenarios);
    expect(errs.some((e) => e.includes("min"))).toBe(true);
  });
});

describe("refHasBaselineFile (git helper smoke)", () => {
  // These tests exercise the git helper against real repo state
  // so future refactors that accidentally remove the repo-root
  // parameter (as happened in round-5 of the fourth review loop,
  // where `ROOT` was left as an undefined top-level reference)
  // fail in unit tests instead of only exploding in CI.

  test("HEAD is recognized (baseline file check runs without ReferenceError)", async () => {
    const result = await refHasBaselineFile("HEAD", REPO_ROOT);
    expect(typeof result).toBe("boolean");
  });

  test("bogus refs raise a thrown error, not a returned false", async () => {
    // Unknown or malformed refs must throw so the caller fails
    // closed on real git infrastructure problems.
    await expect(
      refHasBaselineFile("definitely-not-a-ref-1234567890", REPO_ROOT),
    ).rejects.toThrow();
  });

  test("missing path at a valid ref returns false (bootstrap case)", async () => {
    // git cat-file -e returns exit 128 with 'does not exist' stderr
    // when the path is absent from a valid ref's tree. This is the
    // normal bootstrap case — before the initial baseline is
    // committed. The helper must classify it as a clean absence
    // (false) and NOT throw, or the startup-latency job would
    // permanently fail on the first rollout PR.
    const result = await refHasBaselineFile("HEAD:this-path-definitely-does-not-exist", REPO_ROOT);
    expect(result).toBe(false);
  });
});

describe("formatReport", () => {
  test("renders table with both scenarios", () => {
    const results = [
      {
        scenario: SCENARIO,
        stats: { p50: 100, p90: 120, mean: 105, min: 90, max: 130, samples: 20 },
      },
    ];
    const env = { runner: "local", bun: "1.3.7", arch: "x64" };
    const out = formatReport(results, undefined, env);
    expect(out).toContain("fast-path");
    expect(out).toContain("100.0ms");
    expect(out).toContain("(none — hard-budget only)");
  });
});

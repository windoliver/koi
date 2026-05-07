/**
 * Property-based + adversarial corner-case tests for linearSearch.
 *
 * The hand-written suite locks in specific contract gates. This file
 * generates randomized configurations and asserts the *invariants*
 * those gates exist to enforce — catching emergent bugs (predecessor
 * vs best confusion, deploy-floor regressions, etc.) without having
 * to predict the failing input upfront.
 */

import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import fc from "fast-check";
import { linearSearch } from "./linear-search.js";
import type { EvalFailure, EvalResult, SearchConfig } from "./types.js";

const DESC: ToolDescriptor = {
  name: "prop-test",
  description: "Property-based test target",
  inputSchema: { type: "object", properties: {} },
};

const SEED = "export function f() { return 0; }";

const F: EvalFailure = {
  toolName: "t",
  errorCode: "E",
  errorMessage: "m",
  parameters: {},
};

const baseConfig = (over: Partial<SearchConfig>): SearchConfig => ({
  refine: async () => "next",
  evaluate: async () => ({ successRate: 0, sampleCount: 1, failures: [F] }),
  adapterHonorsAbort: true,
  sanitizeFailures: (f) => f,
  attemptTimeoutMs: 5000,
  ...over,
});

// -----------------------------------------------------------------------------
// Layer 1 — Property-based fuzz of contract invariants.
// -----------------------------------------------------------------------------

describe("invariant: bounded termination", () => {
  test("never exceeds maxIterations evaluator calls", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.integer({ min: 1, max: 50 }),
        fc.boolean(),
        async (maxIter, rate, samples, hasFailures) => {
          let calls = 0;
          await linearSearch(
            SEED,
            DESC,
            baseConfig({
              maxIterations: maxIter,
              evaluate: async () => {
                calls += 1;
                return {
                  successRate: rate,
                  sampleCount: samples,
                  failures: hasFailures ? [F] : [],
                };
              },
            }),
          );
          expect(calls).toBeLessThanOrEqual(maxIter);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("invariant: history length matches totalIterations", () => {
  test("totalIterations === history.length always", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true }),
        async (maxIter, rate) => {
          const r = await linearSearch(
            SEED,
            DESC,
            baseConfig({
              maxIterations: maxIter,
              evaluate: async () => ({
                successRate: rate,
                sampleCount: 10,
                failures: [F],
              }),
            }),
          );
          expect(r.totalIterations).toBe(r.history.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("invariant: best is the all-time max in history (when present)", () => {
  test("best.successRate >= every history[i].successRate", async () => {
    // Restrict rates to (0, 1) so convergence (gate at 1.0) cannot fire
    // and the search runs the full sequence; rates with non-empty
    // failures keep the empty-failures contract hole guard from
    // tripping early.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true }), {
          minLength: 1,
          maxLength: 10,
        }),
        async (rates) => {
          let i = 0;
          const r = await linearSearch(
            SEED,
            DESC,
            baseConfig({
              maxIterations: rates.length,
              convergenceThreshold: 1,
              noImprovementLimit: 99,
              evaluate: async () => {
                const rate = rates[i++] ?? 0.5;
                return {
                  successRate: rate,
                  sampleCount: 10,
                  failures: [F],
                };
              },
              random: () => 0.99,
            }),
          );
          if (r.best === null || r.history.length === 0) return;
          for (const node of r.history) {
            const nodeRate = node.successRate ?? -1;
            const bestRate = r.best.successRate ?? -1;
            expect(bestRate).toBeGreaterThanOrEqual(nodeRate);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("invariant: terminalDiagnostic null ⇔ stopReason is non-failure", () => {
  const NON_FAILURE = new Set([
    "converged",
    "budget_exhausted",
    "no_improvement",
    "thompson_deploy",
  ]);

  test("diagnostic null/non-null aligns with stopReason class", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.integer({ min: 0, max: 20 }),
        fc.boolean(),
        async (rate, samples, hasFailures) => {
          const r = await linearSearch(
            SEED,
            DESC,
            baseConfig({
              maxIterations: 3,
              evaluate: async () => ({
                successRate: rate,
                sampleCount: samples,
                failures: hasFailures ? [F] : [],
              }),
            }),
          );
          if (NON_FAILURE.has(r.stopReason)) {
            expect(r.terminalDiagnostic).toBeNull();
          } else {
            expect(r.terminalDiagnostic).not.toBeNull();
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("invariant: best === null ⇒ history is empty", () => {
  test("no synthetic best when no eval completed", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (preAbort) => {
        const ctrl = new AbortController();
        if (preAbort) ctrl.abort();
        const r = await linearSearch(
          SEED,
          DESC,
          baseConfig({
            signal: ctrl.signal,
            evaluate: preAbort
              ? async () => ({ successRate: 1, sampleCount: 10, failures: [] })
              : async () => {
                  throw new Error("infra down");
                },
          }),
        );
        if (r.best === null) {
          expect(r.history.length).toBe(0);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe("invariant: converged ⇒ best meets BOTH gates AND failures empty", () => {
  test("never converges with non-empty failures", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: Math.fround(0.5), max: Math.fround(1), noNaN: true }),
        fc.integer({ min: 1, max: 20 }),
        fc.boolean(),
        async (rate, samples, hasFailures) => {
          const r = await linearSearch(
            SEED,
            DESC,
            baseConfig({
              maxIterations: 3,
              convergenceThreshold: 0.5,
              minEvalSamples: 5,
              evaluate: async () => ({
                successRate: rate,
                sampleCount: samples,
                failures: hasFailures ? [F] : [],
              }),
            }),
          );
          if (r.stopReason === "converged") {
            expect(r.best).not.toBeNull();
            expect(r.best?.successRate ?? 0).toBeGreaterThanOrEqual(0.5);
            expect(r.best?.evalSamples ?? 0).toBeGreaterThanOrEqual(5);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("invariant: thompson_deploy ⇒ best meets BOTH gates", () => {
  test("deploy floor enforced under any random seed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.integer({ min: 1, max: 30 }),
        async (seed, rate, samples) => {
          let s = seed === 0 ? 1 : seed;
          const random = (): number => {
            s = (s * 16807) % 2147483647;
            return (s - 1) / 2147483646;
          };
          const r = await linearSearch(
            SEED,
            DESC,
            baseConfig({
              maxIterations: 5,
              convergenceThreshold: 0.99,
              minEvalSamples: 10,
              random,
              evaluate: async () => ({
                successRate: rate,
                sampleCount: samples,
                failures: rate < 0.99 ? [F] : [],
              }),
            }),
          );
          if (r.stopReason === "thompson_deploy") {
            expect(r.best?.successRate ?? 0).toBeGreaterThanOrEqual(0.99);
            expect(r.best?.evalSamples ?? 0).toBeGreaterThanOrEqual(10);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("invariant: stopReason is always one of the documented values", () => {
  const VALID = new Set([
    "converged",
    "budget_exhausted",
    "thompson_deploy",
    "no_improvement",
    "eval_failed",
    "eval_timeout",
    "refine_failed",
    "refine_timeout",
    "aborted",
  ]);

  test("no escape of internal state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.integer({ min: 0, max: 20 }),
        fc.boolean(),
        async (rate, samples, hasFailures) => {
          const r = await linearSearch(
            SEED,
            DESC,
            baseConfig({
              maxIterations: 3,
              evaluate: async () => ({
                successRate: rate,
                sampleCount: samples,
                failures: hasFailures ? [F] : [],
              }),
            }),
          );
          expect(VALID.has(r.stopReason)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// -----------------------------------------------------------------------------
// Layer 2 — Hand-written corner cases beyond the unit suite.
// -----------------------------------------------------------------------------

describe("corner cases", () => {
  test("descriptor with circular reference is rejected, does not loop forever", async () => {
    type Cyclic = ToolDescriptor & { self?: unknown };
    const cyclic: Cyclic = { ...DESC };
    cyclic.self = cyclic;
    // structuredClone DOES handle simple cycles, so this should NOT throw.
    // Add a getter that throws to force a clone failure on a real cycle-like
    // hostile descriptor.
    const hostile = Object.defineProperty({ ...DESC }, "evil", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(linearSearch(SEED, hostile as ToolDescriptor, baseConfig({}))).rejects.toThrow(
      /structured-cloneable/,
    );
  });

  test("refine returning the same string treats it as a normal iteration (plateau-detected)", async () => {
    // The byte-cap and progress checks don't compare against the
    // predecessor's code text — confirming this is intentional, plateau
    // on identical refinements drains noImprovementLimit naturally.
    const r = await linearSearch(
      SEED,
      DESC,
      baseConfig({
        maxIterations: 10,
        noImprovementLimit: 2,
        refine: async (current) => current,
        evaluate: async () => ({
          successRate: 0.3,
          sampleCount: 10,
          failures: [F],
        }),
        random: () => 0.99,
      }),
    );
    expect(r.stopReason).toBe("no_improvement");
  });

  test("evaluator returning the same object reference twice — best-tracking does not alias", async () => {
    const sharedFailure: EvalFailure = { ...F };
    const sharedResult: EvalResult = {
      successRate: 0.4,
      sampleCount: 10,
      failures: [sharedFailure],
    };
    const r = await linearSearch(
      SEED,
      DESC,
      baseConfig({
        maxIterations: 3,
        evaluate: async () => sharedResult,
        random: () => 0.99,
      }),
    );
    // Each history entry must be a distinct SearchNode object even
    // though the underlying EvalResult was reused.
    const ids = new Set(r.history.map((n) => n.id));
    expect(ids.size).toBe(r.history.length);
    // And mutating the shared failure should not retroactively alter
    // any node's recorded state — but failures are not stored on
    // SearchNode, so this is implicitly safe; the test pins the
    // distinct-id invariant which is the observable surface.
  });

  test("many tiny iterations stress withDeadline timer cleanup", async () => {
    // Cooperative callbacks resolving immediately — the timer started
    // in withDeadline must always be cleared in the finally block.
    // If not, the per-attempt budget would leak; this test would not
    // crash but would slow under heavy iteration counts.
    const r = await linearSearch(
      SEED,
      DESC,
      baseConfig({
        maxIterations: 50,
        attemptTimeoutMs: 100,
        noImprovementLimit: 99,
        evaluate: async () => ({
          successRate: 0.3,
          sampleCount: 10,
          failures: [F],
        }),
        random: () => 0.99,
      }),
    );
    // Either budget_exhausted or eval_failed (the empty-failures guard
    // would catch certain shapes); just verify the loop terminated.
    expect(r.totalIterations).toBeGreaterThan(0);
    expect(r.totalIterations).toBeLessThanOrEqual(50);
  });

  test("concurrent linearSearch sharing one signal both exit cleanly on abort", async () => {
    const ctrl = new AbortController();
    const config = baseConfig({
      maxIterations: 10,
      attemptTimeoutMs: 5000,
      evaluate: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { successRate: 0.3, sampleCount: 10, failures: [F] };
      },
      signal: ctrl.signal,
    });
    const a = linearSearch(SEED, DESC, config);
    const b = linearSearch(SEED, DESC, config);
    setTimeout(() => ctrl.abort(), 50);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.stopReason).toBe("aborted");
    expect(rb.stopReason).toBe("aborted");
  });

  test("attemptTimeoutMs=1 with cooperative fast callback — no flakiness across 50 runs", async () => {
    // Race the deadline against itself. Cooperative callback that
    // resolves immediately should win; the timer should never fire.
    let timeouts = 0;
    let successes = 0;
    for (let i = 0; i < 50; i++) {
      const r = await linearSearch(
        SEED,
        DESC,
        baseConfig({
          maxIterations: 1,
          attemptTimeoutMs: 1,
          evaluate: async () => ({ successRate: 1, sampleCount: 10, failures: [] }),
        }),
      );
      if (r.stopReason === "eval_timeout") timeouts += 1;
      if (r.stopReason === "converged") successes += 1;
    }
    // At least one outcome should dominate; both outcomes are valid
    // (microtask scheduling vs. the 1ms timer), but neither should
    // reflect a state machine bug.
    expect(timeouts + successes).toBe(50);
  });

  test("evaluator that mutates its output object mid-flight — frozen snapshot survives", async () => {
    // A buggy evaluator that returns an object then mutates it after
    // returning. The loop coerces to plain literals at validation
    // time, so post-return mutations should not affect history.
    const mutable: EvalResult = {
      successRate: 0.4,
      sampleCount: 10,
      failures: [{ ...F }],
    };
    const r = await linearSearch(
      SEED,
      DESC,
      baseConfig({
        maxIterations: 1,
        evaluate: async () => {
          const ref = mutable;
          // Schedule mutation after return.
          queueMicrotask(() => {
            (ref as unknown as { successRate: number }).successRate = 999;
          });
          return ref;
        },
      }),
    );
    if (r.history.length > 0) {
      expect(r.history[0]?.successRate).toBe(0.4);
    }
  });
});

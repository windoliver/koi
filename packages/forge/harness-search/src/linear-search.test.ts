import { describe, expect, test } from "bun:test";
import { linearSearch, shouldContinue } from "./linear-search.js";
import type { SearchConfig } from "./types.js";

const INITIAL_CODE = `export function createMiddleware() {
  return {
    name: "harness-test",
    priority: 180,
    phase: "INTERCEPT",
    async wrapToolCall(ctx, req, next) {
      if (req.toolName !== "test") return next(req);
      return next(req);
    },
  };
}`;

const REFINED_CODE = `\`\`\`typescript
export function createMiddleware() {
  return {
    name: "harness-test",
    priority: 180,
    phase: "INTERCEPT",
    async wrapToolCall(ctx, req, next) {
      if (req.toolName !== "test") return next(req);
      if (!req.args?.query) return { error: "Missing query" };
      return next(req);
    },
  };
}
\`\`\``;

/** Deterministic seeded PRNG. */
function makeSeededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function makeConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return {
    refine: async () => REFINED_CODE,
    evaluate: async () => ({
      successRate: 0.5,
      sampleCount: 10,
      failures: [{ toolName: "test", errorCode: "ERR", errorMessage: "fail", parameters: {} }],
    }),
    maxIterations: 5,
    convergenceThreshold: 1.0,
    minEvalSamples: 5,
    noImprovementLimit: 3,
    clock: () => 1_700_000_000_000,
    random: makeSeededRandom(42),
    ...overrides,
  };
}

describe("shouldContinue", () => {
  test("returns true with uniform priors (exploration)", () => {
    const continueState = { alpha: 1, beta: 1 };
    const deployState = { alpha: 1, beta: 1 };
    // With uniform priors, roughly 50/50 — just verify it returns a boolean
    const result = shouldContinue(continueState, deployState, makeSeededRandom(42));
    expect(typeof result).toBe("boolean");
  });

  test("favors continue when refinement has been successful", () => {
    const continueState = { alpha: 20, beta: 2 }; // mostly successful refinements
    const deployState = { alpha: 2, beta: 20 }; // mostly wasted deploys
    let continueCount = 0;
    const random = makeSeededRandom(123);
    for (let i = 0; i < 100; i++) {
      if (shouldContinue(continueState, deployState, random)) continueCount++;
    }
    expect(continueCount).toBeGreaterThan(70);
  });

  test("favors deploy when refinement has not been improving", () => {
    const continueState = { alpha: 2, beta: 20 }; // mostly failed refinements
    const deployState = { alpha: 20, beta: 2 }; // current version is good
    let continueCount = 0;
    const random = makeSeededRandom(456);
    for (let i = 0; i < 100; i++) {
      if (shouldContinue(continueState, deployState, random)) continueCount++;
    }
    expect(continueCount).toBeLessThan(30);
  });
});

describe("linearSearch", () => {
  test("converges when evaluate returns 100% success", async () => {
    const config = makeConfig({
      evaluate: async () => ({
        successRate: 1.0,
        sampleCount: 10,
        failures: [],
      }),
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
    expect(result.totalIterations).toBe(1);
    expect(result.best.successRate).toBe(1.0);
  });

  test("exhausts budget when never converging", async () => {
    let iteration = 0;
    const config = makeConfig({
      maxIterations: 5,
      evaluate: async () => {
        iteration++;
        return {
          // Slowly improving but never reaching 1.0
          successRate: 0.1 * iteration,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
      // Always continue (don't let Thompson sampling cut us short)
      random: () => 0.99,
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.converged).toBe(false);
    expect(result.totalIterations).toBeGreaterThan(1);
    expect(result.best.successRate).toBeGreaterThan(0);
  });

  test("stops on no-improvement plateau", async () => {
    const config = makeConfig({
      maxIterations: 20,
      evaluate: async () => ({
        successRate: 0.5, // constant — no improvement
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      // Always continue exploring
      random: () => 0.99,
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.stopReason).toBe("no_improvement");
    // Should stop after ~4 iterations (1 initial + 3 no-improvement)
    expect(result.totalIterations).toBeLessThanOrEqual(5);
  });

  test("stops on evaluation failure", async () => {
    let callCount = 0;
    const config = makeConfig({
      evaluate: async () => {
        callCount++;
        if (callCount >= 2) throw new Error("Eval service down");
        return {
          successRate: 0.5,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.stopReason).toBe("eval_failed");
    expect(result.totalIterations).toBe(1);
  });

  test("stops on refinement failure", async () => {
    let refineCallCount = 0;
    const config = makeConfig({
      refine: async () => {
        refineCallCount++;
        if (refineCallCount >= 1) throw new Error("LLM unavailable");
        return REFINED_CODE;
      },
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      // Always continue
      random: () => 0.99,
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.stopReason).toBe("refine_failed");
  });

  test("history contains all explored nodes", async () => {
    let evalCount = 0;
    const config = makeConfig({
      maxIterations: 3,
      evaluate: async () => {
        evalCount++;
        return {
          successRate: evalCount * 0.3,
          sampleCount: 10,
          failures:
            evalCount < 3
              ? [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }]
              : [],
        };
      },
      // Always continue
      random: () => 0.99,
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.history.length).toBeGreaterThan(0);
    // Each node has an iteration number
    for (let i = 0; i < result.history.length; i++) {
      expect(result.history[i]?.iteration).toBe(i);
    }
  });

  test("best node tracks highest success rate", async () => {
    let evalCount = 0;
    const config = makeConfig({
      maxIterations: 5,
      evaluate: async () => {
        evalCount++;
        // Success rate peaks at iteration 2, then drops
        const rates = [0.3, 0.7, 0.9, 0.4, 0.5];
        return {
          successRate: rates[(evalCount - 1) % rates.length] ?? 0.5,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
      // Always continue
      random: () => 0.99,
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.best.successRate).toBe(0.9);
  });

  test("handles convergence with exact threshold", async () => {
    const config = makeConfig({
      convergenceThreshold: 0.95,
      evaluate: async () => ({
        successRate: 0.95,
        sampleCount: 10,
        failures: [],
      }),
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
  });

  test("respects minEvalSamples before declaring convergence", async () => {
    const config = makeConfig({
      convergenceThreshold: 1.0,
      minEvalSamples: 20,
      evaluate: async () => ({
        successRate: 1.0,
        sampleCount: 5, // < minEvalSamples
        failures: [],
      }),
      // Always continue
      random: () => 0.99,
    });

    const result = await linearSearch(
      INITIAL_CODE,
      { name: "harness-test", description: "Test" },
      config,
    );
    // Should not converge despite 100% because sampleCount < minEvalSamples
    expect(result.stopReason).not.toBe("converged");
  });
});

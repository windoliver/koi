import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import { linearSearch, shouldContinue } from "./linear-search.js";
import type { SearchConfig } from "./types.js";

const DESCRIPTOR: ToolDescriptor = {
  name: "harness-test",
  description: "Test target",
  inputSchema: { type: "object", properties: {} },
};

const INITIAL_CODE = `export function createMiddleware() {
  return { name: "harness-test" };
}`;

const REFINED_CODE = `\`\`\`typescript
export function createMiddleware() {
  return { name: "harness-test", refined: true };
}
\`\`\``;

/** Deterministic seeded PRNG (Park-Miller). */
function seededRandom(seed: number): () => number {
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
    // Tests use cooperative in-memory callbacks — opt into retries.
    adapterHonorsAbort: true,
    clock: () => 1_700_000_000_000,
    random: seededRandom(42),
    ...overrides,
  };
}

describe("shouldContinue", () => {
  test("returns boolean under uniform priors", () => {
    const result = shouldContinue({ alpha: 1, beta: 1 }, { alpha: 1, beta: 1 }, seededRandom(42));
    expect(typeof result).toBe("boolean");
  });

  test("favors continue when refine has been improving", () => {
    let count = 0;
    const random = seededRandom(123);
    for (let i = 0; i < 100; i++) {
      if (shouldContinue({ alpha: 20, beta: 2 }, { alpha: 2, beta: 20 }, random)) count++;
    }
    expect(count).toBeGreaterThan(70);
  });

  test("favors deploy when refine has been failing", () => {
    let count = 0;
    const random = seededRandom(456);
    for (let i = 0; i < 100; i++) {
      if (shouldContinue({ alpha: 2, beta: 20 }, { alpha: 20, beta: 2 }, random)) count++;
    }
    expect(count).toBeLessThan(30);
  });
});

describe("linearSearch", () => {
  test("converges when evaluate returns 100% above threshold", async () => {
    const config = makeConfig({
      evaluate: async () => ({ successRate: 1.0, sampleCount: 10, failures: [] }),
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
    expect(result.totalIterations).toBe(1);
    expect(result.best.successRate).toBe(1.0);
  });

  test("budget halts search when never converging", async () => {
    let i = 0;
    const config = makeConfig({
      maxIterations: 5,
      evaluate: async () => {
        i++;
        return {
          successRate: 0.1 * i,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
      // Always continue (skip Thompson deploy)
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.converged).toBe(false);
    expect(result.totalIterations).toBeGreaterThan(1);
    expect(result.totalIterations).toBeLessThanOrEqual(5);
  });

  test("convergence detected when improvement plateaus", async () => {
    const config = makeConfig({
      maxIterations: 20,
      // Tight plateau gate so it fires before the Thompson sampler
      // (which now reads the latest update) can deploy on a flat rate.
      noImprovementLimit: 1,
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.stopReason).toBe("no_improvement");
    expect(result.totalIterations).toBeLessThanOrEqual(5);
  });

  test("refinement strictly improves fitness", async () => {
    let i = 0;
    const rates = [0.3, 0.6, 0.9];
    const config = makeConfig({
      maxIterations: 5,
      evaluate: async () => {
        const rate = rates[i++] ?? 0.9;
        return {
          successRate: rate,
          sampleCount: 10,
          failures:
            rate < 1.0
              ? [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }]
              : [],
        };
      },
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.history.length).toBeGreaterThanOrEqual(3);
    const seen = result.history.map((n) => n.successRate);
    expect(seen[0]).toBeLessThan(seen[2] ?? 0);
    expect(result.best.successRate).toBe(0.9);
  });

  test("best result tracked across iterations even when fitness regresses", async () => {
    let i = 0;
    const rates = [0.3, 0.7, 0.9, 0.4, 0.5];
    const config = makeConfig({
      maxIterations: 5,
      evaluate: async () => ({
        successRate: rates[i++ % rates.length] ?? 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.best.successRate).toBe(0.9);
  });

  test("history covers every explored variant in order", async () => {
    let i = 0;
    const config = makeConfig({
      maxIterations: 3,
      evaluate: async () => ({
        successRate: ++i * 0.3,
        sampleCount: 10,
        failures:
          i < 3 ? [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }] : [],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.history.length).toBeGreaterThan(0);
    for (let idx = 0; idx < result.history.length; idx++) {
      expect(result.history[idx]?.iteration).toBe(idx);
    }
  });

  test("stops on evaluation exception", async () => {
    let calls = 0;
    const config = makeConfig({
      evaluate: async () => {
        if (++calls >= 2) throw new Error("eval down");
        return {
          successRate: 0.5,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
  });

  test("stops on refinement exception", async () => {
    const config = makeConfig({
      refine: async () => {
        throw new Error("LLM down");
      },
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("refine_failed");
  });

  test("respects minEvalSamples gate before declaring convergence", async () => {
    const config = makeConfig({
      convergenceThreshold: 1.0,
      minEvalSamples: 20,
      evaluate: async () => ({ successRate: 1.0, sampleCount: 5, failures: [] }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).not.toBe("converged");
  });

  test("converges at exact threshold", async () => {
    const config = makeConfig({
      convergenceThreshold: 0.95,
      evaluate: async () => ({ successRate: 0.95, sampleCount: 10, failures: [] }),
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
  });

  test("aborts when external signal fires during in-flight evaluate", async () => {
    // Parent abort is a first-class race participant in withDeadline —
    // it wins over the callback's resolution path even when the
    // evaluator is fast/cooperative, so the loop never accepts the
    // result of an attempt the caller has already cancelled.
    const ctrl = new AbortController();
    const config = makeConfig({
      evaluate: async () => {
        ctrl.abort();
        return {
          successRate: 0.3,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
      signal: ctrl.signal,
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("aborted");
    expect(result.totalIterations).toBe(0);
  });

  test("multiple strategies are tried — refined code is fed forward", async () => {
    const codeSeen: string[] = [];
    let i = 0;
    const config = makeConfig({
      maxIterations: 3,
      refine: async (current) => `\`\`\`ts\n${current}\n// refined-${i}\n\`\`\``,
      evaluate: async (code) => {
        codeSeen.push(code);
        i++;
        return {
          successRate: i * 0.2,
          sampleCount: 10,
          failures:
            i < 3 ? [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }] : [],
        };
      },
      random: () => 0.99,
    });
    await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(codeSeen.length).toBeGreaterThanOrEqual(2);
    expect(codeSeen[0]).toBe(INITIAL_CODE);
    expect(codeSeen[1]).not.toBe(INITIAL_CODE);
    expect(codeSeen[1]).toContain("refined");
  });

  test("tied success rate with more samples replaces best (covers convergence consistency)", async () => {
    // Iter 0: rate=1.0 sampleCount=2 (under-sampled, fails minEvalSamples=5).
    // Iter 1: rate=1.0 sampleCount=10 — must satisfy convergence gate AND
    // become the returned best. Otherwise stopReason="converged" but
    // best.evalSamples=2 and result.converged=false (broken contract).
    let i = 0;
    const samples = [2, 10];
    const config = makeConfig({
      maxIterations: 5,
      convergenceThreshold: 1.0,
      minEvalSamples: 5,
      evaluate: async () => ({
        successRate: 1.0,
        sampleCount: samples[i++] ?? 10,
        failures: [],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.stopReason).toBe("converged");
    expect(result.converged).toBe(true);
    expect(result.best.evalSamples).toBe(10);
    expect(result.best.successRate).toBe(1.0);
  });

  test("unparseable refinement output yields refine_failed (no silent reuse)", async () => {
    const config = makeConfig({
      maxIterations: 5,
      refine: async () => "no fenced code block here, just prose",
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("refine_failed");
    expect(result.totalIterations).toBe(1);
  });

  test("empty fenced refinement output yields refine_failed", async () => {
    const config = makeConfig({
      maxIterations: 5,
      refine: async () => "```ts\n   \n```",
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("refine_failed");
  });

  test("eval that ignores its signal hits attemptTimeoutMs and stops with eval_timeout", async () => {
    const config = makeConfig({
      attemptTimeoutMs: 30,
      // Non-cooperative evaluator: never resolves, never honors signal.
      evaluate: () => new Promise(() => {}),
    });
    const start = Date.now();
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    const elapsed = Date.now() - start;

    expect(result.stopReason).toBe("eval_timeout");
    expect(elapsed).toBeLessThan(500);
    expect(result.totalIterations).toBe(0);
  });

  test("refine that ignores its signal hits attemptTimeoutMs and stops with refine_timeout", async () => {
    const config = makeConfig({
      attemptTimeoutMs: 30,
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      refine: () => new Promise(() => {}),
    });
    const start = Date.now();
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    const elapsed = Date.now() - start;

    expect(result.stopReason).toBe("refine_timeout");
    expect(elapsed).toBeLessThan(500);
  });

  test("Infinity attemptTimeoutMs disables deadline (cooperative-only)", async () => {
    let i = 0;
    const config = makeConfig({
      maxIterations: 3,
      attemptTimeoutMs: Number.POSITIVE_INFINITY,
      evaluate: async () => ({
        successRate: ++i * 0.4,
        sampleCount: 10,
        failures:
          i < 3 ? [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }] : [],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.totalIterations).toBeGreaterThan(0);
  });

  test("parent abort terminates non-cooperative callback even with Infinity timeout", async () => {
    const ctrl = new AbortController();
    const config = makeConfig({
      attemptTimeoutMs: Number.POSITIVE_INFINITY,
      // Non-cooperative: never resolves, ignores its signal.
      evaluate: () => new Promise(() => {}),
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 30);
    const start = Date.now();
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    const elapsed = Date.now() - start;

    expect(result.stopReason).toBe("aborted");
    expect(elapsed).toBeLessThan(500);
  });

  test("parent abort beats finite timeout when both could fire", async () => {
    const ctrl = new AbortController();
    const config = makeConfig({
      attemptTimeoutMs: 5_000,
      evaluate: () => new Promise(() => {}),
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 20);
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("aborted");
  });

  test("invalid attemptTimeoutMs throws fast (NaN)", async () => {
    const config = makeConfig({ attemptTimeoutMs: Number.NaN });
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/attemptTimeoutMs/);
  });

  test("invalid attemptTimeoutMs throws fast (zero)", async () => {
    const config = makeConfig({ attemptTimeoutMs: 0 });
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/attemptTimeoutMs/);
  });

  test("invalid attemptTimeoutMs throws fast (negative)", async () => {
    const config = makeConfig({ attemptTimeoutMs: -1 });
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/attemptTimeoutMs/);
  });

  test("invalid maxIterations throws fast", async () => {
    const config = makeConfig({ maxIterations: 0 });
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/maxIterations/);
  });

  test("invalid convergenceThreshold throws fast", async () => {
    const config = makeConfig({ convergenceThreshold: 1.5 });
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/convergenceThreshold/);
  });

  test("malformed evaluator (out-of-range rate) yields eval_failed", async () => {
    const config = makeConfig({
      // Buggy evaluator emitting percentage instead of fraction.
      evaluate: async () => ({ successRate: 95, sampleCount: 10, failures: [] }),
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
    expect(result.converged).toBe(false);
  });

  test("malformed evaluator (NaN rate) yields eval_failed", async () => {
    const config = makeConfig({
      evaluate: async () => ({ successRate: Number.NaN, sampleCount: 10, failures: [] }),
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
  });

  test("malformed evaluator (failures contains null element) yields eval_failed (no TypeError)", async () => {
    const config = makeConfig({
      evaluate: async () =>
        ({
          successRate: 0.5,
          sampleCount: 10,
          failures: [null],
        }) as unknown as Awaited<ReturnType<SearchConfig["evaluate"]>>,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
  });

  test("malformed evaluator (failures missing string fields) yields eval_failed", async () => {
    const config = makeConfig({
      evaluate: async () =>
        ({
          successRate: 0.5,
          sampleCount: 10,
          failures: [{ toolName: 42, errorCode: "E", errorMessage: "m", parameters: {} }],
        }) as unknown as Awaited<ReturnType<SearchConfig["evaluate"]>>,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
  });

  test("hostile evaluator (Proxy whose getters throw) yields eval_failed (no rejection)", async () => {
    const config = makeConfig({
      evaluate: async () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("hostile getter");
            },
          },
        ) as unknown as Awaited<ReturnType<SearchConfig["evaluate"]>>,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
  });

  test("hostile evaluator (Proxy that throws on second access) yields eval_failed", async () => {
    // Validation reads each property once. To exercise the post-validation
    // copy guard, throw on the second property access.
    let accessCount = 0;
    const config = makeConfig({
      evaluate: async () => {
        const ok = {
          successRate: 0.5,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
        return new Proxy(ok, {
          get: (target, prop) => {
            accessCount++;
            if (accessCount > 5) throw new Error("stateful hostile getter");
            return Reflect.get(target, prop);
          },
        }) as unknown as Awaited<ReturnType<SearchConfig["evaluate"]>>;
      },
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    // Either eval_failed (validation caught) or coerce-guarded — either way,
    // the search must NOT reject with a TypeError.
    expect(["eval_failed", "no_improvement", "thompson_deploy", "budget_exhausted"]).toContain(
      result.stopReason,
    );
  });

  test("non-string refinement output yields refine_failed (no TypeError)", async () => {
    const config = makeConfig({
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      // Wrapper accidentally returns structured output.
      refine: (async () => ({
        choices: [{ text: "anything" }],
      })) as unknown as SearchConfig["refine"],
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("refine_failed");
  });

  test("malformed evaluator (negative samples) yields eval_failed", async () => {
    const config = makeConfig({
      evaluate: async () => ({ successRate: 0.9, sampleCount: -1, failures: [] }),
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
  });

  test("default sanitizer redacts errorMessage, parameters, AND errorCode (only toolName preserved)", async () => {
    let receivedFailures: readonly {
      toolName: string;
      errorCode: string;
      errorMessage: string;
      parameters: object;
    }[] = [];
    const config = makeConfig({
      maxIterations: 2,
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [
          {
            toolName: "tool",
            errorCode: "TENANT_ABC_TIMEOUT",
            errorMessage: "secret token=abc123",
            parameters: { tenantId: "private", userInput: "ssn=42" },
          },
        ],
      }),
      refine: async (_code, failures) => {
        receivedFailures = failures;
        return "```ts\nrefined\n```";
      },
      random: () => 0.99,
    });
    await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(receivedFailures.length).toBe(1);
    expect(receivedFailures[0]?.toolName).toBe("tool");
    expect(receivedFailures[0]?.errorCode).toBe("redacted");
    expect(receivedFailures[0]?.errorMessage).toBe("redacted");
    expect(receivedFailures[0]?.parameters).toEqual({});
  });

  test("custom sanitizer can pass failures through (opt-in for trusted evaluators)", async () => {
    let receivedMessage = "";
    const config = makeConfig({
      maxIterations: 2,
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "diagnostic", parameters: {} }],
      }),
      refine: async (_code, failures) => {
        receivedMessage = failures[0]?.errorMessage ?? "";
        return "```ts\nrefined\n```";
      },
      sanitizeFailures: (f) => f,
      random: () => 0.99,
    });
    await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(receivedMessage).toBe("diagnostic");
  });

  test("config compiles with only required callbacks plus minimal safety flag", async () => {
    // Type-level test: this would be a tsc error if SearchConfig still
    // marked maxIterations / convergenceThreshold / etc. as required.
    // adapterHonorsAbort is required to enable the default 20-iteration
    // budget — otherwise linearSearch refuses to run multi-iteration
    // search with potentially non-cooperative callbacks.
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, {
      refine: async () => "```ts\nrefined\n```",
      evaluate: async () => ({ successRate: 1.0, sampleCount: 10, failures: [] }),
      adapterHonorsAbort: true,
    });
    expect(result.stopReason).toBe("converged");
  });

  test("sync throw from evaluate is converted to eval_failed (not propagated as rejection)", async () => {
    const config = makeConfig({
      // Non-async function that throws synchronously before returning a
      // promise — adapters that validate inputs at call entry do this.
      evaluate: (() => {
        throw new Error("invalid input");
      }) as unknown as SearchConfig["evaluate"],
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("eval_failed");
    expect(result.totalIterations).toBe(0);
  });

  test("sync throw from refine is converted to refine_failed (not propagated as rejection)", async () => {
    const config = makeConfig({
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      refine: (() => {
        throw new Error("setup failure");
      }) as unknown as SearchConfig["refine"],
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("refine_failed");
  });

  test("evidence accumulation on tied rate is progress, not plateau (reaches minEvalSamples)", async () => {
    // Iter 0..4: successRate=1.0 with sampleCount climbing 1..5.
    // minEvalSamples=5: only iteration 4 satisfies the convergence gate.
    // Pre-fix: every tied-rate iteration incremented consecutiveNoImprovement
    // and the loop stopped on no_improvement after iter 3, never reaching
    // a legitimate convergence at iter 4.
    let i = 0;
    const config = makeConfig({
      maxIterations: 6,
      noImprovementLimit: 2,
      convergenceThreshold: 1.0,
      minEvalSamples: 5,
      evaluate: async () => ({ successRate: 1.0, sampleCount: ++i, failures: [] }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.stopReason).toBe("converged");
    expect(result.converged).toBe(true);
    expect(result.best.evalSamples).toBe(5);
  });

  test("adapterHonorsAbort rejects non-boolean values (truthy junk)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately exercise runtime guard
    const config = { ...makeConfig(), adapterHonorsAbort: "false" as any };
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/adapterHonorsAbort/);
  });

  test("adapterHonorsAbort rejects numeric values", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately exercise runtime guard
    const config = { ...makeConfig(), adapterHonorsAbort: 1 as any };
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/adapterHonorsAbort/);
  });

  test("default adapterHonorsAbort=false rejects multi-iteration config (no silent single-shot)", async () => {
    // Pre-fix: maxIterations=10 silently became 1 — caller thought
    // they shipped refinement but production only ran one eval and
    // exited with budget_exhausted. Now the misconfiguration throws.
    expect(
      linearSearch(INITIAL_CODE, DESCRIPTOR, {
        refine: async () => "```ts\nrefined\n```",
        evaluate: async () => ({ successRate: 0.4, sampleCount: 10, failures: [] }),
        maxIterations: 10,
      }),
    ).rejects.toThrow(/adapterHonorsAbort/);
  });

  test("default adapterHonorsAbort=false accepts single-shot config (maxIterations=1)", async () => {
    let evalCalls = 0;
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, {
      refine: async () => "```ts\nrefined\n```",
      evaluate: async () => {
        evalCalls++;
        return {
          successRate: 0.4,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
      maxIterations: 1,
    });
    expect(evalCalls).toBe(1);
    expect(result.totalIterations).toBe(1);
    expect(result.stopReason).toBe("budget_exhausted");
  });

  test("parentId follows actual lineage (immediate predecessor), not the historical best", async () => {
    // Iter 0: rate 0.9 (becomes best)
    // Iter 1: rate 0.4 (regression — best stays at iter 0)
    // Iter 2: rate 0.5 (still worse than best, but parent should be iter 1, not iter 0)
    let i = 0;
    const rates = [0.9, 0.4, 0.5];
    const config = makeConfig({
      maxIterations: 3,
      noImprovementLimit: 5,
      evaluate: async () => ({
        successRate: rates[i++] ?? 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(result.history.length).toBe(3);
    expect(result.history[0]?.parentId).toBeNull();
    expect(result.history[1]?.parentId).toBe(result.history[0]?.id ?? "");
    // Critical assertion: parent of iter 2 must be iter 1 (the actual
    // predecessor whose code was refined), NOT iter 0 (the best so far).
    expect(result.history[2]?.parentId).toBe(result.history[1]?.id ?? "");
  });

  test("descriptor mutations by callbacks do not affect later iterations or history", async () => {
    let evalCalls = 0;
    const config = makeConfig({
      maxIterations: 3,
      noImprovementLimit: 5,
      evaluate: async (_code, descriptor) => {
        evalCalls++;
        // Hostile mutation attempt — must not propagate.
        try {
          (descriptor as { name: string }).name = `pwned-${evalCalls}`;
        } catch {
          // frozen — expected
        }
        return {
          successRate: 0.5,
          sampleCount: 10,
          failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
        };
      },
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);

    expect(DESCRIPTOR.name).toBe("harness-test");
    for (const node of result.history) {
      expect(node.descriptor.name).toBe("harness-test");
    }
  });

  test("oversized refinement yields refine_failed (hard byte cap)", async () => {
    const huge = "x".repeat(100_000);
    const config = makeConfig({
      maxRefinedCodeBytes: 1024,
      refine: async () => `\`\`\`ts\n${huge}\n\`\`\``,
      evaluate: async () => ({
        successRate: 0.5,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.stopReason).toBe("refine_failed");
  });

  test("invalid maxRefinedCodeBytes throws fast", async () => {
    const config = makeConfig({ maxRefinedCodeBytes: 0 });
    expect(linearSearch(INITIAL_CODE, DESCRIPTOR, config)).rejects.toThrow(/maxRefinedCodeBytes/);
  });

  test("never exceeds maxIterations even with infinite-failure evaluator", async () => {
    const config = makeConfig({
      maxIterations: 7,
      evaluate: async () => ({
        successRate: 0.0,
        sampleCount: 10,
        failures: [{ toolName: "t", errorCode: "E", errorMessage: "m", parameters: {} }],
      }),
      noImprovementLimit: 999,
      random: () => 0.99,
    });
    const result = await linearSearch(INITIAL_CODE, DESCRIPTOR, config);
    expect(result.totalIterations).toBeLessThanOrEqual(7);
  });
});

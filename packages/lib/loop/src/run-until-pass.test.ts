import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput } from "@koi/core";
import { runUntilPass } from "./run-until-pass.js";
import type {
  LoopEvent,
  LoopRuntime,
  RunUntilPassConfig,
  Verifier,
  VerifierResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fake runtime / verifier helpers
// ---------------------------------------------------------------------------

function doneEvent(totalTokens = 0): EngineEvent {
  const output: EngineOutput = {
    content: [],
    stopReason: "completed",
    metrics: { totalTokens, inputTokens: 0, outputTokens: totalTokens, turns: 1, durationMs: 0 },
  };
  return { kind: "done", output };
}

interface FakeRuntimeOptions {
  readonly tokensPerIteration?: readonly number[];
  readonly emitDone?: boolean;
  readonly throws?: Error;
  readonly hangMs?: number;
  readonly zeroEvents?: boolean;
}

function makeFakeRuntime(opts: FakeRuntimeOptions = {}): {
  readonly runtime: LoopRuntime;
  readonly calls: { count: number; prompts: string[] };
} {
  const calls = { count: 0, prompts: [] as string[] };
  const runtime: LoopRuntime = {
    async *run({ text, signal }) {
      calls.count += 1;
      calls.prompts.push(text);
      if (opts.throws !== undefined) throw opts.throws;
      if (opts.zeroEvents === true) return;
      yield { kind: "text_delta", delta: "..." };
      if (opts.hangMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.hangMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }
      if (opts.emitDone !== false) {
        const tok = opts.tokensPerIteration?.[calls.count - 1] ?? 0;
        yield doneEvent(tok);
      }
    },
  };
  return { runtime, calls };
}

function verifierAlwaysPass(): Verifier {
  return { check: async () => ({ ok: true }) };
}

function verifierAlwaysFail(reason = "exit_nonzero" as const): Verifier {
  return {
    check: async () => ({ ok: false, reason, details: "boom" }),
  };
}

function verifierThatPassesOnIteration(n: number): {
  readonly verifier: Verifier;
  readonly calls: { count: number };
} {
  const calls = { count: 0 };
  const verifier: Verifier = {
    check: async () => {
      calls.count += 1;
      if (calls.count >= n) return { ok: true };
      return { ok: false, reason: "exit_nonzero", details: `fail ${calls.count}` };
    },
  };
  return { verifier, calls };
}

function baseConfig(overrides: Partial<RunUntilPassConfig>): RunUntilPassConfig {
  const { runtime } = makeFakeRuntime();
  return {
    runtime,
    verifier: verifierAlwaysPass(),
    initialPrompt: "do the thing",
    workingDir: "/tmp/test",
    maxIterations: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

describe("runUntilPass — convergence", () => {
  test("converges on iteration 1 when verifier passes immediately", async () => {
    const result = await runUntilPass(baseConfig({ verifier: verifierAlwaysPass() }));
    expect(result.status).toBe("converged");
    expect(result.iterations).toBe(1);
    expect(result.terminalReason).toContain("iteration 1");
  });

  test("converges on iteration N after N-1 failures", async () => {
    const { verifier } = verifierThatPassesOnIteration(3);
    const { runtime } = makeFakeRuntime();
    const result = await runUntilPass(
      baseConfig({ runtime, verifier, maxIterations: 10, maxConsecutiveFailures: 100 }),
    );
    expect(result.status).toBe("converged");
    expect(result.iterations).toBe(3);
  });

  test("rebuildPrompt is called with the latest failure on each retry", async () => {
    const { verifier } = verifierThatPassesOnIteration(3);
    const { runtime, calls } = makeFakeRuntime();
    const seenPrompts: string[] = [];
    await runUntilPass(
      baseConfig({
        runtime,
        verifier,
        maxConsecutiveFailures: 100,
        rebuildPrompt: (ctx) => {
          seenPrompts.push(ctx.initialPrompt);
          return `${ctx.initialPrompt}\n[retry ${ctx.iteration}]`;
        },
      }),
    );
    expect(calls.count).toBe(3);
    expect(seenPrompts.length).toBe(2); // called on iter 2 and 3
    expect(calls.prompts[1]).toContain("[retry 2]");
    expect(calls.prompts[2]).toContain("[retry 3]");
  });
});

// ---------------------------------------------------------------------------
// Exhaustion
// ---------------------------------------------------------------------------

describe("runUntilPass — exhaustion", () => {
  test("exhausted when maxIterations hit", async () => {
    const result = await runUntilPass(
      baseConfig({
        verifier: verifierAlwaysFail(),
        maxIterations: 5,
        maxConsecutiveFailures: 100,
      }),
    );
    expect(result.status).toBe("exhausted");
    expect(result.iterations).toBe(5);
    expect(result.terminalReason).toContain("maxIterations");
  });

  test("regression: verifier is NOT called when maxBudgetTokens hits on the current iteration", async () => {
    // Round 24 fix: if an agent iteration blows through the hard cap,
    // the loop must NOT run the verifier on that same iteration —
    // running it is real extra work (possibly side-effecting subprocess)
    // after the stop condition has already been met.
    let verifierCalls = 0;
    const verifier: Verifier = {
      check: async () => {
        verifierCalls += 1;
        return { ok: true };
      },
    };
    const { runtime } = makeFakeRuntime({ tokensPerIteration: [2000] });
    const result = await runUntilPass(
      baseConfig({
        runtime,
        verifier,
        maxBudgetTokens: 1000, // iteration 1 will consume 2000, blowing the cap
        maxIterations: 10,
      }),
    );
    expect(result.status).toBe("exhausted");
    expect(result.iterations).toBe(1);
    expect(result.tokensConsumed).toBe(2000);
    expect(verifierCalls).toBe(0);
    expect(result.terminalReason).toContain("maxBudgetTokens");
    // Round 40: the synthetic verifier result must use the
    // "skipped_budget_exhausted" reason (not "aborted") so
    // per-iteration telemetry correctly distinguishes budget-driven
    // skips from user-initiated cancellations.
    const record = result.iterationRecords[0];
    if (record === undefined || record.verifierResult.ok) throw new Error("unreachable");
    expect(record.verifierResult.reason).toBe("skipped_budget_exhausted");
    expect(result.terminalReason).toContain("verifier skipped");
  });

  test("exhausted when maxBudgetTokens reached", async () => {
    const { runtime } = makeFakeRuntime({ tokensPerIteration: [600, 600] });
    const result = await runUntilPass(
      baseConfig({
        runtime,
        verifier: verifierAlwaysFail(),
        maxBudgetTokens: 1000,
        maxIterations: 10,
        maxConsecutiveFailures: 100,
      }),
    );
    expect(result.status).toBe("exhausted");
    expect(result.terminalReason).toContain("maxBudgetTokens");
    expect(result.tokensConsumed).toBe(1200);
  });

  test("unmetered default: token count stays unmetered", async () => {
    const { runtime } = makeFakeRuntime({ tokensPerIteration: [500] });
    const result = await runUntilPass(baseConfig({ runtime }));
    expect(result.tokensConsumed).toBe("unmetered");
  });

  test("regression: an iteration with no done event is reported with its real cause, not as a budget error", async () => {
    // Round 18 added a fail-closed guard for metered mode when tokens
    // come back as "unmetered". Round 22 tightened the ordering: the
    // abort/error path must run BEFORE the budget guard, so a
    // cancelled/failed iteration surfaces its real cause instead of
    // being rewritten as a budget problem. A runtime that emits no
    // done event triggers the zero-events/no-done error path, which
    // now wins over the budget guard.
    const { runtime } = makeFakeRuntime({ emitDone: false });
    const result = await runUntilPass(
      baseConfig({
        runtime,
        verifier: verifierAlwaysPass(),
        maxBudgetTokens: 1000,
        maxConsecutiveFailures: 100,
      }),
    );
    expect(result.status).toBe("errored");
    // Real cause preserved — the reason mentions the runtime-level
    // failure, not the budget.
    expect(result.terminalReason).toContain("done");
    expect(result.terminalReason).not.toContain("maxBudgetTokens");
  });

  test("regression: tokens reported by a failed iteration are still counted in cumulative spend", async () => {
    // Round 37 fix: round 22's ordering change ran abort/error checks
    // BEFORE the metered-budget accumulation, which meant an iteration
    // that reported tokens via a done event and THEN errored (e.g. on
    // stopReason != "completed") would drop those tokens from the
    // running total. Real spend was being under-reported.
    //
    // The new contract: accumulate metered tokens up front, then run
    // the abort/error checks. Failed iterations have their real spend
    // reflected in result.tokensConsumed.
    const runtime: LoopRuntime = {
      async *run() {
        yield { kind: "text_delta", delta: "partial" };
        yield {
          kind: "done",
          output: {
            content: [],
            stopReason: "max_turns", // non-completed → triggers errored path
            metrics: {
              totalTokens: 777,
              inputTokens: 500,
              outputTokens: 277,
              turns: 1,
              durationMs: 0,
            },
          },
        };
      },
    };
    const result = await runUntilPass(
      baseConfig({
        runtime,
        verifier: verifierAlwaysPass(),
        maxBudgetTokens: 10_000,
      }),
    );
    // The iteration failed (stopReason != "completed") but its 777
    // tokens were real spend — the cumulative count must reflect them.
    expect(result.status).toBe("errored");
    expect(result.tokensConsumed).toBe(777);
  });

  test("regression: abort during iteration is reported as 'aborted', not as a budget error", async () => {
    // An aborted iteration typically has tokens === "unmetered" (no
    // done event). The round 22 ordering fix ensures the abort check
    // runs BEFORE the metered-budget guard, so the terminal status
    // reflects the real cause (user cancellation) and not a budget
    // problem.
    const ctrl = new AbortController();
    const { runtime } = makeFakeRuntime({ emitDone: false, hangMs: 100 });
    setTimeout(() => ctrl.abort(), 20);
    const result = await runUntilPass(
      baseConfig({
        runtime,
        signal: ctrl.signal,
        maxBudgetTokens: 1000,
        maxConsecutiveFailures: 100,
      }),
    );
    expect(result.status).toBe("aborted");
    expect(result.terminalReason).not.toContain("maxBudgetTokens");
  });

  test("metered-mode hard-cap invariant: well-behaved runtime still converges", async () => {
    // Smoke: the fail-closed guard must not trip when the runtime is
    // well-behaved (every iteration reports usage).
    const { runtime } = makeFakeRuntime({ tokensPerIteration: [100] });
    const result = await runUntilPass(
      baseConfig({
        runtime,
        verifier: verifierAlwaysPass(),
        maxBudgetTokens: 10_000,
      }),
    );
    expect(result.status).toBe("converged");
    expect(result.tokensConsumed).toBe(100);
  });

  test("metered mode captures token totals from done events", async () => {
    const { runtime } = makeFakeRuntime({ tokensPerIteration: [300, 400] });
    const { verifier } = verifierThatPassesOnIteration(2);
    const result = await runUntilPass(
      baseConfig({ runtime, verifier, maxBudgetTokens: 10_000, maxConsecutiveFailures: 100 }),
    );
    expect(result.tokensConsumed).toBe(700);
    expect(result.status).toBe("converged");
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker (pure counter, no text comparison)
// ---------------------------------------------------------------------------

describe("runUntilPass — circuit breaker", () => {
  test("trips after exactly maxConsecutiveFailures failures", async () => {
    const result = await runUntilPass(
      baseConfig({
        verifier: verifierAlwaysFail(),
        maxConsecutiveFailures: 3,
        maxIterations: 100,
      }),
    );
    expect(result.status).toBe("circuit_broken");
    expect(result.iterations).toBe(3);
  });

  test("does NOT do text comparison — distinct failure messages still trip", async () => {
    let n = 0;
    const verifier: Verifier = {
      check: async () => {
        n += 1;
        return { ok: false, reason: "exit_nonzero", details: `unique failure ${n}` };
      },
    };
    const result = await runUntilPass(
      baseConfig({ verifier, maxConsecutiveFailures: 3, maxIterations: 100 }),
    );
    expect(result.status).toBe("circuit_broken");
    expect(result.iterations).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("runUntilPass — abort", () => {
  test("pre-aborted signal runs 0 iterations, returns aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { runtime, calls } = makeFakeRuntime();
    const result = await runUntilPass(baseConfig({ runtime, signal: ctrl.signal }));
    expect(result.status).toBe("aborted");
    expect(result.iterations).toBe(0);
    expect(calls.count).toBe(0);
  });

  test("abort during verifier → aborted terminal", async () => {
    const ctrl = new AbortController();
    const verifier: Verifier = {
      check: async () => {
        ctrl.abort();
        return { ok: false, reason: "aborted", details: "external abort" };
      },
    };
    const result = await runUntilPass(baseConfig({ verifier, signal: ctrl.signal }));
    expect(result.status).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// Zero-event / no-done handling
// ---------------------------------------------------------------------------

describe("runUntilPass — runtime errors", () => {
  test("zero events → errored, verifier not called", async () => {
    const { runtime } = makeFakeRuntime({ zeroEvents: true });
    let verifierCalled = false;
    const verifier: Verifier = {
      check: async () => {
        verifierCalled = true;
        return { ok: true };
      },
    };
    const result = await runUntilPass(baseConfig({ runtime, verifier }));
    expect(result.status).toBe("errored");
    expect(result.terminalReason).toContain("zero events");
    expect(verifierCalled).toBe(false);
  });

  test("stream ends without done → errored, verifier not called", async () => {
    const { runtime } = makeFakeRuntime({ emitDone: false });
    let verifierCalled = false;
    const verifier: Verifier = {
      check: async () => {
        verifierCalled = true;
        return { ok: true };
      },
    };
    const result = await runUntilPass(baseConfig({ runtime, verifier }));
    expect(result.status).toBe("errored");
    expect(result.terminalReason).toContain("'done'");
    expect(verifierCalled).toBe(false);
  });

  test("runtime throws → errored", async () => {
    const { runtime } = makeFakeRuntime({ throws: new Error("adapter crashed") });
    const result = await runUntilPass(baseConfig({ runtime }));
    expect(result.status).toBe("errored");
    expect(result.terminalReason).toContain("adapter crashed");
  });

  test("iteration timeout → errored", async () => {
    const { runtime } = makeFakeRuntime({ hangMs: 500 });
    const result = await runUntilPass(baseConfig({ runtime, iterationTimeoutMs: 50 }));
    expect(result.status).toBe("errored");
    expect(result.terminalReason).toContain("timeout");
  });

  test("regression: non-'completed' stopReason is treated as errored, verifier not called", async () => {
    // Engine returns a done event with stopReason 'max_turns' — this is
    // a truncated turn, not a successful completion. The loop must fail
    // closed and NOT call the verifier, matching the single-prompt CLI
    // contract. Tests each non-completed stop reason.
    for (const stopReason of ["max_turns", "interrupted", "error"] as const) {
      const runtime: LoopRuntime = {
        async *run() {
          yield { kind: "text_delta", delta: "partial" };
          yield {
            kind: "done",
            output: {
              content: [],
              stopReason,
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 1,
                durationMs: 0,
              },
            },
          };
        },
      };
      let verifierCalled = false;
      const verifier: Verifier = {
        check: async () => {
          verifierCalled = true;
          return { ok: true };
        },
      };
      const result = await runUntilPass(baseConfig({ runtime, verifier }));
      expect(result.status).toBe("errored");
      expect(verifierCalled).toBe(false);
      expect(result.terminalReason).toContain(stopReason);
    }
  });

  test("regression: iterator without return() cannot positively fence off cleanup → cleanupTimedOut on abort", async () => {
    // The structural LoopRuntime interface permits async iterators that
    // don't expose a return() method. On abort, the loop can't signal
    // cancellation to such an iterator, so it cannot prove the background
    // stream has stopped — and must fail closed rather than reporting a
    // clean terminal state. Previously, my cleanup fence only fired when
    // iter.return() returned a promise, so next-only iterators bypassed
    // the fence entirely.
    const runtime: LoopRuntime = {
      run: () => ({
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          return {
            // next() hangs forever — forces the iteration timeout path
            next: () => new Promise(() => {}),
            // Deliberately NO return() method
          };
        },
      }),
    };
    const result = await runUntilPass(
      baseConfig({
        runtime,
        iterationTimeoutMs: 50,
        // Raise the breaker so the test asserts cleanup-timeout is the
        // binding constraint, not circuit breaker or max iterations.
        maxIterations: 10,
        maxConsecutiveFailures: 100,
      }),
    );
    expect(result.status).toBe("errored");
    expect(result.iterations).toBe(1);
    expect(result.terminalReason).toContain("cleanup");
  });

  test("regression: iterator without return() succeeds on clean completion path (no false positive)", async () => {
    // The clean-completion path should NOT trip the cleanup fence. A
    // next-only iterator that cleanly ends its stream (returns
    // { done: true }) is fine — there's nothing to clean up because the
    // iterator is already exhausted. The fence only fires on abort/error.
    const runtime: LoopRuntime = {
      run: () => ({
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          let i = 0;
          return {
            next: async (): Promise<IteratorResult<EngineEvent>> => {
              i += 1;
              if (i === 1) {
                return {
                  value: {
                    kind: "done",
                    output: {
                      content: [],
                      stopReason: "completed",
                      metrics: {
                        totalTokens: 10,
                        inputTokens: 5,
                        outputTokens: 5,
                        turns: 1,
                        durationMs: 0,
                      },
                    },
                  },
                  done: false,
                };
              }
              return { value: undefined, done: true };
            },
            // Deliberately NO return() method
          };
        },
      }),
    };
    const result = await runUntilPass(baseConfig({ runtime, verifier: verifierAlwaysPass() }));
    expect(result.status).toBe("converged");
    expect(result.iterations).toBe(1);
  });

  test("regression: aborted iter.next() rejection is observed (no unhandled rejection)", async () => {
    // When abort wins the race, the losing iter.next() promise is
    // abandoned. If the runtime rejects it as part of cancellation
    // cleanup, that rejection would otherwise propagate as an
    // unhandled-rejection at the process level. runOneIteration must
    // attach a catch handler up front.
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const runtime: LoopRuntime = {
        run: () => ({
          [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            return {
              // next() will eventually reject when abort fires, simulating
              // a runtime that rejects in-flight operations on cancellation.
              next: (): Promise<IteratorResult<EngineEvent>> =>
                new Promise((_resolve, reject) => {
                  setTimeout(() => reject(new Error("cancelled")), 30);
                }),
              // No return() — forces the loop to abandon without cleanup.
            };
          },
        }),
      };
      await runUntilPass(baseConfig({ runtime, iterationTimeoutMs: 10 }));
      // Give the rejected promise microtask time to propagate.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", listener);
    }
    // The loop must not have leaked an unhandled rejection.
    expect(unhandled.filter((r) => (r as Error).message === "cancelled")).toHaveLength(0);
  });

  test("regression: hung iterator.return() cannot wedge the loop (bounded cleanup)", async () => {
    // A runtime whose iterator.return() hangs forever — the worst-case
    // shape of a real async generator stuck in a non-abortable await.
    // runOneIteration must NOT hang waiting for return() to settle; it
    // races against a bounded cleanup budget and abandons the iterator
    // if cleanup takes too long.
    const runtime: LoopRuntime = {
      run: () => ({
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          return {
            next: () => new Promise(() => {}), // hangs forever
            return: () => new Promise(() => {}), // cleanup also hangs forever
          };
        },
      }),
    };
    const startedAt = Date.now();
    const result = await runUntilPass(baseConfig({ runtime, iterationTimeoutMs: 50 }));
    const elapsed = Date.now() - startedAt;
    // 50ms iteration timeout + 100ms cleanup budget + overhead.
    // A hung return() would make this never return — 2s is a very loose
    // bound that still catches the regression.
    expect(elapsed).toBeLessThan(2000);
    expect(result.status).toBe("errored");
  });

  test("regression: abort + verifier-cleanup-timeout is 'errored', not 'aborted'", async () => {
    // When the external abort signal fires AND the verifier's check()
    // promise doesn't settle within the cleanup budget, the loop must
    // report "errored" rather than "aborted". A caller that sees
    // "aborted" might interpret it as clean cancellation and start a
    // new run against the same workspace while the old verifier is
    // still executing — which is exactly the isolation hazard the
    // cleanup fence exists to prevent.
    const ctrl = new AbortController();
    const wedgedVerifier: Verifier = {
      check: () => new Promise(() => {}), // never settles
    };
    // Fire the abort a few ms into the run so the verifier phase starts.
    setTimeout(() => ctrl.abort(), 20);
    const result = await runUntilPass(
      baseConfig({
        verifier: wedgedVerifier,
        verifierTimeoutMs: 5000, // much longer than the abort delay
        signal: ctrl.signal,
        maxConsecutiveFailures: 1,
      }),
    );
    // The abort path saw a verifier whose cleanup did not settle.
    // Status is promoted from aborted → errored.
    expect(result.status).toBe("errored");
    expect(result.terminalReason).toContain("external abort");
    expect(result.terminalReason).toContain("cleanup budget");
  });

  test("regression: verifier cleanup timeout is non-retriable — loop fails closed", async () => {
    // A verifier whose check() promise never resolves AND never observes
    // ctx.signal. The timeout race fires after verifierTimeoutMs, and
    // then runVerifier's cleanup budget kicks in: check() still isn't
    // settling, so cleanupTimedOut becomes true. The main loop must
    // return an errored terminal state instead of retrying — the
    // verifier's background work could still be mutating state.
    const wedgedVerifier: Verifier = {
      check: () => new Promise(() => {}),
    };
    const startedAt = Date.now();
    const result = await runUntilPass(
      baseConfig({
        verifier: wedgedVerifier,
        verifierTimeoutMs: 50,
        // Raise the breaker so a naive "just retry" would try 10 times.
        // We assert the loop stops on iteration 1 instead.
        maxIterations: 10,
        maxConsecutiveFailures: 100,
      }),
    );
    const elapsed = Date.now() - startedAt;
    // 50ms verifier timeout + 500ms cleanup budget + overhead.
    // A hung verifier that's not fenced would hang forever.
    expect(elapsed).toBeLessThan(3000);
    expect(result.status).toBe("errored");
    expect(result.iterations).toBe(1);
    expect(result.terminalReason).toContain("verifier cleanup timed out");
  });

  test("regression: cleanup timeout is non-retriable — loop fails closed immediately", async () => {
    // Even with maxConsecutiveFailures high enough to allow retries and
    // an always-passing verifier, a hung iter.return() must terminate
    // the loop immediately. Continuing to retry while an orphaned
    // stream could still mutate shared state would violate the loop's
    // isolation contract.
    const runtime: LoopRuntime = {
      run: () => ({
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          return {
            next: () => new Promise(() => {}),
            return: () => new Promise(() => {}),
          };
        },
      }),
    };
    let verifierCalls = 0;
    const verifier: Verifier = {
      check: async () => {
        verifierCalls += 1;
        return { ok: true };
      },
    };
    const result = await runUntilPass(
      baseConfig({
        runtime,
        verifier,
        iterationTimeoutMs: 50,
        maxIterations: 10,
        maxConsecutiveFailures: 100,
      }),
    );
    // Exactly one iteration recorded, with a cleanup-timeout reason.
    expect(result.status).toBe("errored");
    expect(result.iterations).toBe(1);
    expect(result.terminalReason).toContain("cleanup timed out");
    // Verifier must NOT have been called — cleanup timeout short-circuits
    // before the verifier phase.
    expect(verifierCalls).toBe(0);
  });

  test("regression: orphaned iterator is cancelled via .return() on abort", async () => {
    // Build a runtime whose iterator records whether .return() was called.
    // On abort, runOneIteration must invoke return() so the runtime can
    // clean up — otherwise late events from this abandoned stream could
    // still mutate shared state after the next iteration starts.
    let returnCalled = false;
    const runtime: LoopRuntime = {
      run: () => ({
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          return {
            next: () => new Promise(() => {}), // hangs forever
            return: (value) => {
              returnCalled = true;
              return Promise.resolve({ value, done: true });
            },
          };
        },
      }),
    };
    await runUntilPass(baseConfig({ runtime, iterationTimeoutMs: 50 }));
    expect(returnCalled).toBe(true);
  });

  test("regression: iteration timeout is preemptive — non-cooperative runtime cannot hang the loop", async () => {
    // A runtime that completely ignores the signal argument. Without
    // preemptive timeout enforcement, runOneIteration would wait forever
    // on the for-await loop and iterationTimeoutMs would never fire.
    const nonCooperativeRuntime: LoopRuntime = {
      // Intentionally does not accept/observe the signal parameter
      run: () => ({
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          return {
            next: () => new Promise(() => {}), // never resolves
          };
        },
      }),
    };
    const startedAt = Date.now();
    const result = await runUntilPass(
      baseConfig({ runtime: nonCooperativeRuntime, iterationTimeoutMs: 50 }),
    );
    const elapsed = Date.now() - startedAt;
    // Should terminate within ~50ms + overhead, certainly under 2s.
    expect(elapsed).toBeLessThan(2000);
    expect(result.status).toBe("errored");
  });
});

// ---------------------------------------------------------------------------
// Verifier failure taxonomy + prompt rebuilding
// ---------------------------------------------------------------------------

describe("runUntilPass — verifier failures", () => {
  test("regression: timeout is preemptive — non-cooperative verifier cannot hang the loop", async () => {
    // This verifier ignores ctx.signal entirely. runVerifier must still
    // return a timeout result within roughly verifierTimeoutMs via Promise.race,
    // without waiting for verifier.check() to cooperate.
    const nonCooperativeVerifier: Verifier = {
      check: () => new Promise(() => {}), // never resolves, never observes signal
    };
    const startedAt = Date.now();
    const result = await runUntilPass(
      baseConfig({
        verifier: nonCooperativeVerifier,
        verifierTimeoutMs: 50,
        maxConsecutiveFailures: 1,
      }),
    );
    const elapsed = Date.now() - startedAt;
    // Generous upper bound: preemptive timeout should fire within a few
    // hundred ms of the configured 50ms; anything near seconds indicates
    // we're still waiting on the verifier to cooperate.
    expect(elapsed).toBeLessThan(1000);
    const record = result.iterationRecords[0];
    if (record === undefined || record.verifierResult.ok) throw new Error("unreachable");
    expect(record.verifierResult.reason).toBe("timeout");
  });

  test("regression: outer verifierTimeoutMs surfaces as 'timeout', not 'aborted'", async () => {
    // A gate that hangs forever on the combined signal. When the OUTER
    // verifierTimeoutMs fires, the gate catches the combined-signal abort
    // and returns reason: "aborted" — runVerifier must post-process that
    // into reason: "timeout" so telemetry can distinguish an unhealthy
    // verifier from a user cancellation.
    const hangingVerifier: Verifier = {
      check: (ctx) =>
        new Promise((_resolve) => {
          ctx.signal.addEventListener("abort", () => {
            // Mimic createArgvGate's behavior: any signal abort becomes
            // reason "aborted" inside the gate.
            _resolve({
              ok: false,
              reason: "aborted",
              details: "gate saw signal abort",
            });
          });
        }),
    };
    const result = await runUntilPass(
      baseConfig({
        verifier: hangingVerifier,
        verifierTimeoutMs: 50,
        maxConsecutiveFailures: 1,
      }),
    );
    const record = result.iterationRecords[0];
    if (record === undefined || record.verifierResult.ok) throw new Error("unreachable");
    expect(record.verifierResult.reason).toBe("timeout");
  });

  test("external abort (not timeout) is still reported as 'aborted'", async () => {
    // Same hanging verifier, but this time the EXTERNAL signal fires first.
    // runVerifier must NOT rewrite this to timeout.
    const ctrl = new AbortController();
    const hangingVerifier: Verifier = {
      check: (ctx) =>
        new Promise((_resolve) => {
          ctx.signal.addEventListener("abort", () => {
            _resolve({
              ok: false,
              reason: "aborted",
              details: "gate saw signal abort",
            });
          });
        }),
    };
    setTimeout(() => ctrl.abort(), 30);
    const result = await runUntilPass(
      baseConfig({
        verifier: hangingVerifier,
        verifierTimeoutMs: 5000, // much longer than abort delay
        signal: ctrl.signal,
        maxConsecutiveFailures: 1,
      }),
    );
    expect(result.status).toBe("aborted");
  });

  test("regression: synchronous runtime.run() throw is caught and becomes errored terminal", async () => {
    // Round 32 fix: if a LoopRuntime implementation throws synchronously
    // before returning an AsyncIterable (null check failure, config
    // validation inside run(), type error, etc.), the exception used to
    // escape runOneIteration and propagate up to runUntilPass, bypassing
    // the loop's terminal-state contract. Now it's caught and converted
    // into a normal errored terminal.
    const runtime: LoopRuntime = {
      run: () => {
        throw new Error("runtime synchronously refused to start");
      },
    };
    const result = await runUntilPass(baseConfig({ runtime, maxConsecutiveFailures: 1 }));
    // The loop returned a terminal result instead of letting the error escape.
    expect(result.status).toBe("errored");
    expect(result.terminalReason).toContain("runtime.run() threw before returning");
    expect(result.terminalReason).toContain("synchronously refused to start");
  });

  test("regression: runtime failure uses 'runtime_error' reason, not 'predicate_threw'", async () => {
    // Round 30 fix: recordErroredIteration previously used
    // reason="predicate_threw" for every non-abort runtime failure,
    // conflating runtime-side faults with verifier-side faults. The
    // new "runtime_error" reason lets callers distinguish "verifier
    // said no" from "we never got to the verifier".
    const { runtime } = makeFakeRuntime({ throws: new Error("adapter crashed") });
    const result = await runUntilPass(baseConfig({ runtime, maxConsecutiveFailures: 1 }));
    const record = result.iterationRecords[0];
    if (record === undefined || record.verifierResult.ok) throw new Error("unreachable");
    expect(record.verifierResult.reason).toBe("runtime_error");
    expect(record.runtimeError).toContain("adapter crashed");
  });

  test("verifier throws → predicate_threw", async () => {
    const verifier: Verifier = {
      check: async () => {
        throw new Error("verifier crashed");
      },
    };
    const result = await runUntilPass(baseConfig({ verifier, maxConsecutiveFailures: 1 }));
    expect(result.status).toBe("circuit_broken");
    const record = result.iterationRecords[0];
    if (record === undefined) throw new Error("no record");
    expect(record.verifierResult.ok).toBe(false);
    if (record.verifierResult.ok) throw new Error("unreachable");
    expect(record.verifierResult.reason).toBe("predicate_threw");
    expect(record.verifierResult.details).toContain("verifier crashed");
  });

  test("verifier result details are sanitized (ANSI stripped)", async () => {
    const verifier: Verifier = {
      check: async (): Promise<VerifierResult> => ({
        ok: false,
        reason: "exit_nonzero",
        details: "\x1B[31mred error\x1B[0m",
      }),
    };
    const result = await runUntilPass(baseConfig({ verifier, maxConsecutiveFailures: 1 }));
    const record = result.iterationRecords[0];
    if (record === undefined || record.verifierResult.ok) throw new Error("unreachable");
    expect(record.verifierResult.details).not.toContain("\x1B");
    expect(record.verifierResult.details).toContain("red error");
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("runUntilPass — events", () => {
  test("onEvent receives every event in temporal order", async () => {
    const { verifier } = verifierThatPassesOnIteration(2);
    const { runtime } = makeFakeRuntime();
    const events: LoopEvent[] = [];
    await runUntilPass(
      baseConfig({
        runtime,
        verifier,
        maxConsecutiveFailures: 100,
        onEvent: (e) => events.push(e),
      }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "loop.iteration.start",
      "loop.verifier.start",
      "loop.verifier.complete",
      "loop.iteration.complete",
      "loop.iteration.start",
      "loop.verifier.start",
      "loop.verifier.complete",
      "loop.iteration.complete",
      "loop.terminal",
    ]);
  });

  test("terminal event carries the final result payload", async () => {
    let terminalResult: LoopEvent | undefined;
    await runUntilPass(
      baseConfig({
        onEvent: (e) => {
          if (e.kind === "loop.terminal") terminalResult = e;
        },
      }),
    );
    expect(terminalResult).toBeDefined();
    if (terminalResult?.kind !== "loop.terminal") throw new Error("unreachable");
    expect(terminalResult.result.status).toBe("converged");
  });

  test("a throwing onEvent listener does not corrupt the loop", async () => {
    const result = await runUntilPass(
      baseConfig({
        onEvent: () => {
          throw new Error("listener is broken");
        },
      }),
    );
    expect(result.status).toBe("converged");
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("runUntilPass — config validation", () => {
  test("throws when workingDir is missing", async () => {
    await expect(
      runUntilPass({
        ...baseConfig({}),
        // @ts-expect-error testing runtime guard
        workingDir: undefined,
      }),
    ).rejects.toThrow(/workingDir/);
  });

  test("throws when initialPrompt is empty", async () => {
    await expect(runUntilPass(baseConfig({ initialPrompt: "" }))).rejects.toThrow(/initialPrompt/);
  });

  test("throws when maxIterations < 1", async () => {
    await expect(runUntilPass(baseConfig({ maxIterations: 0 }))).rejects.toThrow(/maxIterations/);
  });

  test("throws when maxBudgetTokens is non-positive number", async () => {
    await expect(runUntilPass(baseConfig({ maxBudgetTokens: 0 }))).rejects.toThrow(
      /maxBudgetTokens/,
    );
  });
});

import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineInput } from "@koi/core";
import { exactMatch } from "./graders/exact-match.js";
import { computeTaskFingerprint, runEval } from "./runner.js";
import type { AgentHandle, EvalGrader, EvalTask } from "./types.js";

function fakeAgent(events: readonly EngineEvent[]): AgentHandle {
  // Append a terminal done if the caller didn't include one — runner now
  // requires a "completed" done event to grade as success. The done event
  // carries a text block summarizing the streamed deltas so exactMatch
  // (which treats done as authoritative) sees the same content.
  const hasDone = events.some((e) => e.kind === "done");
  const deltaText = events
    .filter((e): e is Extract<EngineEvent, { kind: "text_delta" }> => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
  const done: EngineEvent = {
    kind: "done",
    output: {
      content: deltaText.length > 0 ? [{ kind: "text", text: deltaText }] : [],
      stopReason: "completed",
      metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
    },
  };
  const stream = hasDone ? events : [...events, done];
  return {
    stream: async function* (_input: EngineInput): AsyncIterable<EngineEvent> {
      for (const ev of stream) yield ev;
    },
  };
}

function task(id: string, expected: string, graders: readonly EvalGrader[]): EvalTask {
  return {
    id,
    name: id,
    input: { kind: "text", text: "go" },
    expected: { kind: "text", pattern: expected },
    graders,
  };
}

const fixedClock = (): (() => number) => {
  let n = 0;
  return () => {
    n += 10;
    return n;
  };
};

describe("runEval", () => {
  test("produces a run with summary, passing trial", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "hello world" }];
    const run = await runEval({
      name: "smoke",
      tasks: [task("t1", "hello", [exactMatch()])],
      agentFactory: () => fakeAgent(events),
      now: fixedClock(),
      idGen: () => "run-1",
    });
    expect(run.id).toBe("run-1");
    expect(run.name).toBe("smoke");
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]?.status).toBe("pass");
    expect(run.summary.passRate).toBe(1);
    expect(run.summary.taskCount).toBe(1);
    expect(run.summary.errorCount).toBe(0);
  });

  test("captures error when agent throws", async () => {
    const run = await runEval({
      name: "boom",
      tasks: [task("t1", "x", [exactMatch()])],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => {
          async function* gen(): AsyncIterable<EngineEvent> {
            yield await Promise.reject(new Error("kaboom"));
          }
          return gen();
        },
      }),
      idGen: () => "run-x",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("kaboom");
    expect(run.summary.errorCount).toBe(1);
  });

  test("unconfirmed cancellation aborts the run before later trials/tasks run", async () => {
    const calls: string[] = [];
    const run = await runEval({
      name: "abort-on-unconfirmed",
      tasks: [
        { ...task("t1", "x", [exactMatch()]), timeoutMs: 20 },
        task("t2", "ok", [exactMatch()]),
      ],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => {
          calls.push("stream");
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise(() => {}),
            }),
          };
        },
      }),
      disposeTimeoutMs: 20,
      idGen: () => "run-abort",
    });
    expect(run.trials).toHaveLength(1);
    expect(run.aborted).toBe(true);
    expect(run.abortReason).toBe("cancellation_unconfirmed");
    expect(calls).toHaveLength(1);
  });

  test("timeout on iterable without return() reports cancellation: 'unconfirmed'", async () => {
    const run = await runEval({
      name: "no-return",
      tasks: [{ ...task("t1", "x", [exactMatch()]), timeoutMs: 20 }],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => ({
          [Symbol.asyncIterator]: () => ({
            // Note: no `return()` method
            next: () => new Promise(() => {}),
          }),
        }),
      }),
      disposeTimeoutMs: 20,
      idGen: () => "run-nr",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.cancellation).toBe("unconfirmed");
  });

  test("signal-only cooperative iterable (no return()) reports confirmed cancellation", async () => {
    // Spec contract is `AsyncIterable` + `EngineInput.signal`. A stream
    // that honors signal but exposes only next() must NOT be flagged as
    // a leaked agent — that would treat every conformant cooperative
    // agent as an isolation failure and abort the rest of a suite.
    const run = await runEval({
      name: "signal-only",
      tasks: [{ ...task("t1", "x", [exactMatch()]), timeoutMs: 20 }],
      agentFactory: () => ({
        stream: (input): AsyncIterable<EngineEvent> => ({
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<EngineEvent>> =>
              new Promise<IteratorResult<EngineEvent>>((resolve) => {
                if (input.signal === undefined) return; // hang
                if (input.signal.aborted) {
                  resolve({ value: undefined as unknown as EngineEvent, done: true });
                  return;
                }
                input.signal.addEventListener(
                  "abort",
                  () => resolve({ value: undefined as unknown as EngineEvent, done: true }),
                  { once: true },
                );
              }),
          }),
        }),
      }),
      disposeTimeoutMs: 20,
      idGen: () => "run-so",
    });
    expect(run.trials[0]?.status).toBe("error");
    // returnAwaited === true (next() settled) → cancellation = "confirmed".
    expect(run.trials[0]?.cancellation).toBe("confirmed");
    expect(run.aborted).toBeUndefined();
  });

  test("synchronous stream() failure does not orphan timeout rejection", async () => {
    const run = await runEval({
      name: "sync-fail",
      tasks: [task("t1", "x", [exactMatch()])],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => {
          throw new Error("sync-boom");
        },
      }),
      idGen: () => "run-sb",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("sync-boom");
    // Wait long enough for any orphaned timer to fire — if it does and is
    // unhandled, Bun will surface a rejection on the next tick.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  test("hanging agent's trial is reported with cancellation: 'unconfirmed'", async () => {
    const run = await runEval({
      name: "hang-cancel",
      tasks: [{ ...task("t1", "x", [exactMatch()]), timeoutMs: 20 }],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => {
          async function* gen(): AsyncGenerator<EngineEvent, void, unknown> {
            await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
            yield { kind: "text_delta", delta: "never" };
          }
          return gen();
        },
        dispose: () => new Promise<void>(() => {}),
      }),
      disposeTimeoutMs: 20,
      idGen: () => "run-uc",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.cancellation).toBe("unconfirmed");
    expect(run.trials[0]?.error).toContain("cancellation unconfirmed");
  });

  test("extracts EngineMetrics from terminal done event", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "ok" },
      {
        kind: "done",
        output: {
          content: [{ kind: "text", text: "ok" }],
          stopReason: "completed",
          metrics: {
            totalTokens: 100,
            inputTokens: 60,
            outputTokens: 40,
            turns: 2,
            durationMs: 1234,
            costUsd: 0.005,
          },
        },
      },
    ];
    const run = await runEval({
      name: "metrics",
      tasks: [task("t1", "ok", [exactMatch()])],
      agentFactory: () => fakeAgent(events),
      idGen: () => "run-m",
    });
    const m = run.trials[0]?.metrics;
    expect(m?.totalTokens).toBe(100);
    expect(m?.turns).toBe(2);
    expect(m?.costUsd).toBe(0.005);
  });

  test("cooperative agent reports cancellation: 'n/a' on success", async () => {
    const run = await runEval({
      name: "ok",
      tasks: [task("t1", "ok", [exactMatch()])],
      agentFactory: () => ({
        stream: async function* (): AsyncIterable<EngineEvent> {
          yield { kind: "text_delta", delta: "ok" };
        },
      }),
      idGen: () => "run-ok",
    });
    expect(run.trials[0]?.cancellation).toBe("n/a");
  });

  test("times out a hanging agent that ignores abort signal", async () => {
    const run = await runEval({
      name: "hang",
      tasks: [{ ...task("t1", "x", [exactMatch()]), timeoutMs: 30 }],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          async function* gen(): AsyncGenerator<EngineEvent, void, unknown> {
            try {
              await new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 200);
              });
              yield { kind: "text_delta", delta: "never" };
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          }
          return gen();
        },
      }),
      idGen: () => "run-hang",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("timeout");
  });

  test("times out long-running trial", async () => {
    const run = await runEval({
      name: "slow",
      tasks: [{ ...task("t1", "x", [exactMatch()]), timeoutMs: 20 }],
      agentFactory: () => ({
        stream: async function* (input: EngineInput): AsyncIterable<EngineEvent> {
          await new Promise<void>((resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("timeout")));
            setTimeout(resolve, 200);
          });
          yield { kind: "text_delta", delta: "late" };
        },
      }),
      idGen: () => "run-slow",
    });
    expect(run.trials[0]?.status).toBe("error");
  });

  test("runs multiple trials and aggregates", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "ok" }];
    const trialsObserved: number[] = [];
    const run = await runEval({
      name: "multi",
      tasks: [{ ...task("t1", "ok", [exactMatch()]), trialCount: 3 }],
      agentFactory: () => fakeAgent(events),
      onTrialComplete: (t) => trialsObserved.push(t.trialIndex),
      idGen: () => "run-m",
    });
    expect(run.trials).toHaveLength(3);
    expect(trialsObserved).toEqual([0, 1, 2]);
    expect(run.summary.byTask[0]?.trials).toBe(3);
  });

  test("hanging dispose does not wedge the run", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "ok" }];
    const start = Date.now();
    const run = await runEval({
      name: "hang-dispose",
      tasks: [task("t1", "ok", [exactMatch()])],
      agentFactory: () => ({
        stream: async function* (): AsyncIterable<EngineEvent> {
          for (const ev of events) yield ev;
        },
        dispose: () => new Promise<void>(() => {}),
      }),
      disposeTimeoutMs: 30,
      idGen: () => "run-hd",
    });
    expect(run.trials).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("dispose called even after error", async () => {
    let disposed = 0;
    await runEval({
      name: "dispose",
      tasks: [task("t1", "x", [exactMatch()])],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => {
          async function* gen(): AsyncIterable<EngineEvent> {
            yield await Promise.reject(new Error("x"));
          }
          return gen();
        },
        dispose: () => {
          disposed += 1;
        },
      }),
      idGen: () => "run-d",
    });
    expect(disposed).toBe(1);
  });

  test("rejects duplicate task ids", async () => {
    await expect(
      runEval({
        name: "dup",
        tasks: [task("same", "x", [exactMatch()]), task("same", "y", [exactMatch()])],
        agentFactory: () => fakeAgent([]),
      }),
    ).rejects.toThrow(/duplicate task id/);
  });

  test("onTrialComplete throwing does not lose collected run", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "ok" }];
    const run = await runEval({
      name: "hook-throws",
      tasks: [task("t1", "ok", [exactMatch()])],
      agentFactory: () => fakeAgent(events),
      onTrialComplete: () => {
        throw new Error("hook-broke");
      },
      idGen: () => "run-ht",
    });
    expect(run.id).toBe("run-ht");
    expect(run.trials).toHaveLength(1);
  });

  test("synchronous dispose throw does not crash the run", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "ok" }];
    const run = await runEval({
      name: "sync-dispose",
      tasks: [task("t1", "ok", [exactMatch()])],
      agentFactory: () => ({
        stream: async function* (): AsyncIterable<EngineEvent> {
          for (const ev of events) yield ev;
        },
        dispose: () => {
          throw new Error("sync-dispose-boom");
        },
      }),
      idGen: () => "run-sd",
    });
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]?.cancellation).toBe("unconfirmed");
    expect(run.aborted).toBe(true);
  });

  test("hung dispose on a successful trial still triggers run abort", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "ok" }];
    const factories: number[] = [];
    const run = await runEval({
      name: "hung-dispose-success",
      tasks: [task("t1", "ok", [exactMatch()]), task("t2", "ok", [exactMatch()])],
      agentFactory: () => {
        factories.push(1);
        return {
          stream: async function* (): AsyncIterable<EngineEvent> {
            for (const ev of events) yield ev;
          },
          dispose: () => new Promise<void>(() => {}),
        };
      },
      disposeTimeoutMs: 20,
      idGen: () => "run-hd-ok",
    });
    expect(run.aborted).toBe(true);
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]?.cancellation).toBe("unconfirmed");
    expect(factories).toHaveLength(1);
  });

  test("dispose rejection causes cancellation: 'unconfirmed' on timeout", async () => {
    const run = await runEval({
      name: "dispose-throw",
      tasks: [{ ...task("t1", "x", [exactMatch()]), timeoutMs: 20 }],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => ({
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        }),
        dispose: () => Promise.reject(new Error("dispose-fail")),
      }),
      idGen: () => "run-dt",
    });
    expect(run.trials[0]?.cancellation).toBe("unconfirmed");
  });

  test("fails fast when a task has non-fingerprintable input and no salt", async () => {
    let factoryCalled = 0;
    await expect(
      runEval({
        name: "ff",
        tasks: [
          {
            id: "t1",
            name: "t1",
            input: {
              ...{ kind: "text" as const, text: "go" },
              callHandlers: { x: () => undefined },
            } as never,
            graders: [exactMatch()],
          },
        ],
        agentFactory: () => {
          factoryCalled += 1;
          return fakeAgent([]);
        },
        idGen: () => "ff",
      }),
    ).rejects.toThrow(/fingerprintSalt/);
    expect(factoryCalled).toBe(0);
  });

  test("default trialCount is resolved into the fingerprint", async () => {
    // A task that omits `trialCount` resolves to EVAL_DEFAULTS.TRIAL_COUNT.
    // Persist the resolved value so two tasks differing only in implicit
    // vs explicit default still produce the same fingerprint, AND a
    // suite that changes the default sample count cannot reuse the
    // baseline silently.
    const t1 = computeTaskFingerprint({
      id: "t",
      name: "t",
      input: { kind: "text", text: "go" } as never,
      graders: [exactMatch()],
    });
    const t2 = computeTaskFingerprint({
      id: "t",
      name: "t",
      input: { kind: "text", text: "go" } as never,
      graders: [exactMatch()],
      trialCount: 1,
    });
    expect(t1).toBe(t2);
    const t3 = computeTaskFingerprint({
      id: "t",
      name: "t",
      input: { kind: "text", text: "go" } as never,
      graders: [exactMatch()],
      trialCount: 5,
    });
    expect(t3).not.toBe(t1);
  });

  test("AbortSignal in input does not require fingerprintSalt", async () => {
    // EngineInput.signal is the documented cancellation channel, not part
    // of task identity. Routine cancellation plumbing must not turn into
    // a hard config error: the runner strips signal before fingerprinting.
    const upstream = new AbortController();
    const run = await runEval({
      name: "signal-fp",
      tasks: [
        {
          id: "t1",
          name: "t1",
          input: { ...{ kind: "text" as const, text: "go" }, signal: upstream.signal } as never,
          expected: { kind: "text", pattern: "go" },
          graders: [exactMatch()],
        },
      ],
      agentFactory: () => fakeAgent([{ kind: "text_delta", delta: "go" }]),
      idGen: () => "sfp",
    });
    expect(run.trials[0]?.status).toBe("pass");
    // Two trials with different signal *instances* but the same task spec
    // must produce identical fingerprints — signal identity is not semantic.
    const fp1 = computeTaskFingerprint({
      id: "t1",
      name: "t1",
      input: { kind: "text", text: "go", signal: new AbortController().signal } as never,
      graders: [exactMatch()],
    });
    const fp2 = computeTaskFingerprint({
      id: "t1",
      name: "t1",
      input: { kind: "text", text: "go", signal: new AbortController().signal } as never,
      graders: [exactMatch()],
    });
    expect(fp1).toBe(fp2);
  });

  test("already-aborted upstream signal fails the trial without calling agent.stream", async () => {
    let factoryCalled = 0;
    let streamCalled = 0;
    const upstream = new AbortController();
    upstream.abort(new Error("outer-cancel"));
    const run = await runEval({
      name: "upstream-aborted",
      tasks: [
        {
          id: "t1",
          name: "t1",
          input: { ...{ kind: "text" as const, text: "go" }, signal: upstream.signal } as never,
          graders: [exactMatch()],
          fingerprintSalt: "test-upstream-aborted",
        },
      ],
      agentFactory: () => {
        factoryCalled += 1;
        return {
          stream: (): AsyncIterable<EngineEvent> => {
            streamCalled += 1;
            return (async function* (): AsyncIterable<EngineEvent> {})();
          },
        };
      },
      idGen: () => "ua",
    });
    expect(factoryCalled).toBe(0);
    expect(streamCalled).toBe(0);
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.cancellation).toBe("unconfirmed");
    expect(run.aborted).toBe(true);
  });

  test("mid-flight upstream abort cancels the running trial", async () => {
    const upstream = new AbortController();
    const sawAbort = new Promise<void>((resolve) => {
      setTimeout(() => {
        upstream.abort(new Error("cancel-now"));
        resolve();
      }, 30);
    });
    const run = await runEval({
      name: "upstream-mid",
      tasks: [
        {
          id: "t1",
          name: "t1",
          input: { ...{ kind: "text" as const, text: "go" }, signal: upstream.signal } as never,
          graders: [exactMatch()],
          fingerprintSalt: "test-upstream-mid",
          timeoutMs: 5_000,
        },
      ],
      agentFactory: () => ({
        stream: (): AsyncIterable<EngineEvent> => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => {}),
            return: async (): Promise<IteratorResult<EngineEvent>> => ({
              value: undefined,
              done: true,
            }),
          }),
        }),
      }),
      disposeTimeoutMs: 50,
      idGen: () => "um",
    });
    await sawAbort;
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.cancellation).not.toBe("n/a");
  });

  test("rejects empty config", async () => {
    await expect(
      runEval({
        name: "",
        tasks: [task("t1", "x", [exactMatch()])],
        agentFactory: () => fakeAgent([]),
      }),
    ).rejects.toThrow();
    await expect(
      runEval({ name: "x", tasks: [], agentFactory: () => fakeAgent([]) }),
    ).rejects.toThrow();
  });

  test("trial errors when stream ends without terminal done event", async () => {
    const run = await runEval({
      name: "no-done",
      tasks: [task("t1", "anything", [exactMatch()])],
      agentFactory: () => ({
        stream: async function* (): AsyncIterable<EngineEvent> {
          yield { kind: "text_delta", delta: "partial answer" };
        },
      }),
      idGen: () => "run-nd",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("done");
  });

  test("trial errors when events appear after the terminal done", async () => {
    const run = await runEval({
      name: "post-done",
      tasks: [task("t1", "x", [exactMatch()])],
      agentFactory: () => ({
        stream: async function* (): AsyncIterable<EngineEvent> {
          yield {
            kind: "done",
            output: {
              content: [{ kind: "text", text: "x" }],
              stopReason: "completed",
              metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
            },
          };
          // Buggy adapter keeps yielding after done.
          yield { kind: "text_delta", delta: "leak" };
        },
      }),
      idGen: () => "run-pd",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("after");
  });

  test("max_turns terminal is a successful run (matches core mapping)", async () => {
    const run = await runEval({
      name: "max-turns",
      tasks: [task("t1", "ok", [exactMatch()])],
      agentFactory: () => ({
        stream: async function* (): AsyncIterable<EngineEvent> {
          yield {
            kind: "done",
            output: {
              content: [{ kind: "text", text: "ok" }],
              stopReason: "max_turns",
              metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
            },
          };
        },
      }),
      idGen: () => "mt",
    });
    expect(run.trials[0]?.status).toBe("pass");
  });

  test("trial errors when terminal done has non-completed stop reason", async () => {
    const run = await runEval({
      name: "stopped",
      tasks: [task("t1", "x", [exactMatch()])],
      agentFactory: () => ({
        stream: async function* (): AsyncIterable<EngineEvent> {
          yield {
            kind: "done",
            output: {
              content: [{ kind: "text", text: "x" }],
              stopReason: "error",
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 0,
                durationMs: 0,
              },
            },
          };
        },
      }),
      idGen: () => "run-st",
    });
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("error");
  });

  test("grader exception becomes failed score, not crash", async () => {
    const badGrader: EvalGrader = {
      id: "bad",
      grade: () => {
        throw new Error("grader-broke");
      },
    };
    const run = await runEval({
      name: "g",
      tasks: [task("t1", "x", [badGrader])],
      agentFactory: () => fakeAgent([{ kind: "text_delta", delta: "any" }]),
      idGen: () => "g",
    });
    expect(run.trials[0]?.status).toBe("fail");
    expect(run.trials[0]?.scores[0]?.reasoning).toContain("grader-broke");
  });
});

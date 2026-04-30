import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineInput } from "@koi/core";
import { exactMatch } from "./graders/exact-match.js";
import { runEval } from "./runner.js";
import type { AgentHandle, EvalGrader, EvalTask } from "./types.js";

function fakeAgent(events: readonly EngineEvent[]): AgentHandle {
  return {
    stream: async function* (_input: EngineInput): AsyncIterable<EngineEvent> {
      for (const ev of events) yield ev;
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

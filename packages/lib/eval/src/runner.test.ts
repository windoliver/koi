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

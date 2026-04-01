import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineInput } from "@koi/core";
import { createEvalRunner } from "./runner.js";
import type { AgentHandle, EvalRunConfig, EvalTrial } from "./types.js";

function createMockAgent(events: readonly EngineEvent[]): AgentHandle {
  return {
    stream(_input: EngineInput): AsyncIterable<EngineEvent> {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) {
            yield event;
          }
        },
      };
    },
    async dispose(): Promise<void> {
      // no-op
    },
  };
}

const DONE_EVENT: EngineEvent = {
  kind: "done",
  output: {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 50,
    },
  },
};

const TEXT_EVENTS: readonly EngineEvent[] = [
  { kind: "text_delta", delta: "hello world" },
  DONE_EVENT,
];

const BASE_TASK = {
  id: "t1",
  name: "Test Task",
  input: { kind: "text" as const, text: "say hello" },
  expected: { kind: "text" as const, pattern: "hello" },
  graders: [
    {
      id: "test-grader",
      name: "Test Grader",
      grade: (_transcript: readonly EngineEvent[], _expected: unknown, _metrics: unknown) => ({
        graderId: "test-grader",
        score: 1,
        pass: true,
      }),
    },
  ],
};

const baseConfig: EvalRunConfig = {
  name: "test-eval",
  tasks: [BASE_TASK],
  agentFactory: async () => createMockAgent(TEXT_EVENTS),
};

describe("createEvalRunner", () => {
  test("throws on invalid config", () => {
    expect(() => createEvalRunner({ name: "" } as unknown as EvalRunConfig)).toThrow();
  });

  test("runs a simple evaluation", async () => {
    const runner = createEvalRunner(baseConfig);
    const run = await runner.run();

    expect(run.name).toBe("test-eval");
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]?.status).toBe("pass");
    expect(run.summary.taskCount).toBe(1);
    expect(run.summary.passRate).toBe(1);
  });

  test("creates fresh agent per trial", async () => {
    // let justified: tracking agent creation count
    let agentCount = 0;

    const config: EvalRunConfig = {
      ...baseConfig,
      tasks: [{ ...BASE_TASK, trialCount: 3 }],
      agentFactory: async () => {
        agentCount += 1;
        return createMockAgent(TEXT_EVENTS);
      },
    };

    const runner = createEvalRunner(config);
    await runner.run();

    expect(agentCount).toBe(3);
  });

  test("handles agent errors gracefully", async () => {
    const config: EvalRunConfig = {
      ...baseConfig,
      agentFactory: async () => ({
        stream: (): AsyncIterable<EngineEvent> => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("Agent crashed")),
          }),
        }),
      }),
    };

    const runner = createEvalRunner(config);
    const run = await runner.run();

    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("Agent crashed");
  });

  test("handles trial timeout", async () => {
    const config: EvalRunConfig = {
      ...baseConfig,
      tasks: [{ ...BASE_TASK, timeoutMs: 50 }],
      agentFactory: async () => ({
        stream: () => ({
          [Symbol.asyncIterator]: async function* () {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            yield DONE_EVENT;
          },
        }),
      }),
    };

    const runner = createEvalRunner(config);
    const run = await runner.run();

    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.error).toContain("timed out");
  }, 10_000);

  test("calls onTrialComplete callback", async () => {
    const completed: EvalTrial[] = [];

    const config: EvalRunConfig = {
      ...baseConfig,
      onTrialComplete: (trial) => completed.push(trial),
    };

    const runner = createEvalRunner(config);
    await runner.run();

    expect(completed).toHaveLength(1);
    expect(completed[0]?.taskId).toBe("t1");
  });

  test("handles grader errors gracefully", async () => {
    const config: EvalRunConfig = {
      ...baseConfig,
      tasks: [
        {
          ...BASE_TASK,
          graders: [
            {
              id: "broken",
              name: "Broken Grader",
              grade: () => {
                throw new Error("Grader exploded");
              },
            },
          ],
        },
      ],
    };

    const runner = createEvalRunner(config);
    const run = await runner.run();

    expect(run.trials[0]?.scores[0]?.score).toBe(0);
    expect(run.trials[0]?.scores[0]?.reasoning).toContain("Grader error");
  });

  test("disposes agents after trials", async () => {
    // let justified: tracking disposal count
    let disposed = 0;

    const config: EvalRunConfig = {
      ...baseConfig,
      agentFactory: async () => ({
        ...createMockAgent(TEXT_EVENTS),
        async dispose() {
          disposed += 1;
        },
      }),
    };

    const runner = createEvalRunner(config);
    await runner.run();

    expect(disposed).toBe(1);
  });

  test("preserves run config snapshot", async () => {
    const runner = createEvalRunner(baseConfig);
    const run = await runner.run();

    expect(run.config.name).toBe("test-eval");
    expect(run.config.concurrency).toBe(5);
    expect(run.config.timeoutMs).toBe(60_000);
    expect(run.config.passThreshold).toBe(0.5);
    expect(run.config.taskCount).toBe(1);
  });
});

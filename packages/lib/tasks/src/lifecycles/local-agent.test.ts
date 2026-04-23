import { afterEach, describe, expect, test } from "bun:test";
import { taskItemId } from "@koi/core";
import { createOutputStream } from "../output-stream.js";
import { createLocalAgentLifecycle, type LocalAgentConfig } from "./local-agent.js";

describe("createLocalAgentLifecycle", () => {
  const lifecycle = createLocalAgentLifecycle();
  const runningTasks: Array<{ readonly cancel: () => void }> = [];

  afterEach(async () => {
    for (const task of runningTasks) {
      task.cancel();
    }
    runningTasks.length = 0;
  });

  test("kind is local_agent", () => {
    expect(lifecycle.kind).toBe("local_agent");
  });

  test("start returns LocalAgentTask with correct shape", async () => {
    const output = createOutputStream();
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: { prompt: "hello" },
      run: async function* () {
        yield "done";
      },
    };
    const task = await lifecycle.start(taskItemId("task_1"), output, config);
    runningTasks.push(task);

    expect(task.kind).toBe("local_agent");
    expect(task.taskId).toBe(taskItemId("task_1"));
    expect(task.agentType).toBe("worker");
    expect(typeof task.cancel).toBe("function");
    expect(task.startedAt).toBeGreaterThan(0);
  });

  test("output streams chunks from run generator", async () => {
    const output = createOutputStream();
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      run: async function* () {
        yield "chunk-one";
        yield " chunk-two";
      },
    };
    const task = await lifecycle.start(taskItemId("task_2"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const chunks = output.read(0);
    const combined = chunks.map((c) => c.content).join("");
    expect(combined).toContain("chunk-one");
    expect(combined).toContain("chunk-two");
  });

  test("writes exit code 0 on natural completion", async () => {
    const output = createOutputStream();
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      run: async function* () {
        yield "result";
      },
    };
    const task = await lifecycle.start(taskItemId("task_3"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    expect(combined).toContain("[exit code: 0]");
  });

  test("calls onExit with 0 on natural completion", async () => {
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      onExit: (code) => {
        exitCode = code;
      },
      run: async function* () {
        yield "ok";
      },
    };
    const task = await lifecycle.start(taskItemId("task_4"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exitCode).toBe(0);
  });

  test("calls onExit with 1 when run rejects", async () => {
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      onExit: (code) => {
        exitCode = code;
      },
      run: async function* (): AsyncGenerator<string> {
        yield "partial";
        throw new Error("agent failed");
      },
    };
    const task = await lifecycle.start(taskItemId("task_5"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exitCode).toBe(1);
  });

  test("writes error message on run rejection", async () => {
    const output = createOutputStream();
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      // biome-ignore lint/correctness/useYield: generator that always throws — no yield reachable
      run: async function* (): AsyncGenerator<string> {
        throw new Error("boom");
      },
    };
    const task = await lifecycle.start(taskItemId("task_6"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    expect(combined).toContain("boom");
  });

  test("stop cancels the running agent", async () => {
    const output = createOutputStream();
    let aborted = false;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      run: async function* (_agentType, _inputs, signal) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
          setTimeout(resolve, 60_000);
        });
      },
    };
    const task = await lifecycle.start(taskItemId("task_7"), output, config);
    runningTasks.push(task);

    await lifecycle.stop(task);
    runningTasks.pop();

    expect(aborted).toBe(true);
  });

  test("timeout aborts long-running agent", async () => {
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      timeout: 100,
      onExit: (code) => {
        exitCode = code;
      },
      run: async function* (_agentType, _inputs, signal) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timeout")));
          setTimeout(resolve, 60_000);
        });
      },
    };
    const task = await lifecycle.start(taskItemId("task_8"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 300));
    runningTasks.pop();

    expect(exitCode).toBe(1);
  });

  test("signal is aborted when cancel() is called", async () => {
    const output = createOutputStream();
    let signalAborted = false;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      run: async function* (_agentType, _inputs, signal) {
        signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      },
    };
    const task = await lifecycle.start(taskItemId("task_9"), output, config);
    task.cancel();
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signalAborted).toBe(true);
  });

  test("env and inputs are forwarded to run callback", async () => {
    const output = createOutputStream();
    let capturedAgentType: string | undefined;
    let capturedInputs: unknown;
    const config: LocalAgentConfig = {
      agentType: "researcher",
      inputs: { topic: "ai" },
      run: async function* (agentType, inputs) {
        capturedAgentType = agentType;
        capturedInputs = inputs;
        yield "done";
      },
    };
    const task = await lifecycle.start(taskItemId("task_10"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(capturedAgentType).toBe("researcher");
    expect(capturedInputs).toEqual({ topic: "ai" });
  });
});

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

  test("stop cancels the running agent and awaits pipe settlement", async () => {
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

    // stop() must resolve only after the pipe has settled
    await lifecycle.stop(task);
    runningTasks.pop();

    expect(aborted).toBe(true);
  });

  test("stop() does not fire onExit — explicit cancel is not a failure", async () => {
    const output = createOutputStream();
    let exitCalled = false;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      onExit: () => {
        exitCalled = true;
      },
      run: async function* (_agentType, _inputs, signal) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(resolve, 60_000);
        });
      },
    };
    const task = await lifecycle.start(taskItemId("task_7b"), output, config);

    await lifecycle.stop(task);

    // Give any late callbacks time to fire if the guard is broken
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exitCalled).toBe(false);
  });

  test("no output is written after stop() resolves", async () => {
    const output = createOutputStream();
    let yieldedAfterAbort = false;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      run: async function* (_agentType, _inputs, signal) {
        // Yield before abort
        yield "before";
        // Simulate slow abort acknowledgement
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
          setTimeout(resolve, 60_000);
        });
        // This yield should be suppressed by the isStopped() guard
        yieldedAfterAbort = true;
        yield "after-abort";
      },
    };
    const task = await lifecycle.start(taskItemId("task_7c"), output, config);

    await lifecycle.stop(task);

    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    expect(combined).not.toContain("after-abort");
    // yieldedAfterAbort may be true (consumer yielded) but output was suppressed
    void yieldedAfterAbort; // explicitly ignore — we only care about output
  });

  test("timeout fires onExit(1) and writes [timed out]", async () => {
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
    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    expect(combined).toContain("[timed out]");
  });

  test("timeout where run() exits cleanly (no throw) still reports as timed out", async () => {
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      timeout: 100,
      onExit: (code) => {
        exitCode = code;
      },
      // Compliant run() that exits cleanly on abort instead of throwing
      run: async function* (_agentType, _inputs, signal) {
        yield "partial";
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
          setTimeout(resolve, 60_000);
        });
        // Returns normally (no throw) after seeing abort — must still be timed out
      },
    };
    const task = await lifecycle.start(taskItemId("task_8b"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 300));
    runningTasks.pop();

    expect(exitCode).toBe(1);
    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    expect(combined).toContain("[timed out]");
    expect(combined).not.toContain("[exit code: 0]");
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

  test("timeout fires onExit after drain attempt on stuck agent (no second yield)", async () => {
    // Key regression: agent yields once then hangs forever ignoring abort.
    // onExit fires after the drain window (timeout + drainTimeoutMs), not
    // at the timeout boundary, so cleanup is attempted before marking terminal.
    const shortDrainLifecycle2 = createLocalAgentLifecycle({ drainTimeoutMs: 50 });
    const output = createOutputStream();
    let exitCode: number | undefined;

    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      timeout: 100,
      onExit: (code) => {
        exitCode = code;
      },
      run: async function* () {
        yield "first";
        // Stuck forever — no throw, no more yields, ignores abort
        await new Promise<never>(() => {});
      },
    };
    const task = await shortDrainLifecycle2.start(taskItemId("task_13"), output, config);
    runningTasks.push(task);

    // Wait past timeout (100ms) + drain (50ms) + slack
    await new Promise((resolve) => setTimeout(resolve, 300));
    runningTasks.pop();

    expect(exitCode).toBe(1);
    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    // Stuck generator with no hardKill: cleanup cannot be confirmed
    expect(combined).toContain("[timed out: cleanup incomplete]");
    expect(combined).not.toContain("[exit code: 0]");
  });

  test("non-cooperative agent: output stops after timeout even if iterator keeps yielding", async () => {
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      timeout: 100,
      onExit: (code) => {
        exitCode = code;
      },
      // Deliberately ignores abort and keeps yielding
      run: async function* () {
        let i = 0;
        for (;;) {
          yield `chunk-${String(i++)}`;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
    };
    const task = await lifecycle.start(taskItemId("task_11"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 300));
    runningTasks.pop();

    expect(exitCode).toBe(1);
    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    // Timed out is reported
    expect(combined).toContain("[timed out]");
    // No success marker despite iterator still running
    expect(combined).not.toContain("[exit code: 0]");
  });

  test("hardKill is called when drain window expires on permanently-stuck iterator", async () => {
    // Short drain timeout so the test doesn't take 2s
    const shortDrainLifecycle = createLocalAgentLifecycle({ drainTimeoutMs: 80 });
    const output = createOutputStream();
    let hardKillCalled = false;

    // External latch: never resolves — simulates an agent that ignores abort
    // and stays stuck on an external resource indefinitely.
    let stuckResolve!: () => void;
    const stuckLatch = new Promise<void>((r) => {
      stuckResolve = r;
    });

    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      hardKill: () => {
        hardKillCalled = true;
        stuckResolve(); // unblock the generator so the test can clean up
      },
      // Iterator yields once, then blocks on the external latch — never returns.
      run: async function* () {
        yield "start";
        await stuckLatch;
      },
    };
    const task = await shortDrainLifecycle.start(taskItemId("task_12"), output, config);
    // Yield to the event loop so the pipe advances past "start" and into the
    // stuck await — ensuring stop() finds the loop blocked between next() calls.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // stop() blocks for drainTimeoutMs (80ms) then fires hardKill
    await shortDrainLifecycle.stop(task);

    expect(hardKillCalled).toBe(true);
  });

  test("throwing onExit during timeout does not crash the lifecycle", async () => {
    const shortDrainLifecycle = createLocalAgentLifecycle({ drainTimeoutMs: 50 });
    const output = createOutputStream();
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      timeout: 100,
      onExit: () => {
        throw new Error("onExit threw");
      },
      run: async function* () {
        yield "start";
        await new Promise<never>(() => {}); // stuck
      },
    };
    const task = await shortDrainLifecycle.start(taskItemId("task_14b"), output, config);
    runningTasks.push(task);

    // Should not throw despite onExit throwing
    await new Promise((resolve) => setTimeout(resolve, 300));
    runningTasks.pop();

    // Terminal message still written despite onExit failure (stuck → cleanup incomplete)
    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    expect(combined).toContain("[timed out: cleanup incomplete]");
  });

  test("throwing hardKill does not escape stop() or timeout", async () => {
    const shortDrainLifecycle = createLocalAgentLifecycle({ drainTimeoutMs: 80 });
    const output = createOutputStream();
    let stuckResolve!: () => void;
    const stuckLatch = new Promise<void>((r) => {
      stuckResolve = r;
    });
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      hardKill: () => {
        stuckResolve();
        throw new Error("hardKill threw");
      },
      run: async function* () {
        yield "start";
        await stuckLatch;
      },
    };
    const task = await shortDrainLifecycle.start(taskItemId("task_15"), output, config);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // stop() must not throw even if hardKill throws
    await expect(shortDrainLifecycle.stop(task)).resolves.toBeUndefined();
  });

  test("throwing hardKill on timeout does not escape the timeout callback", async () => {
    const shortDrainLifecycle = createLocalAgentLifecycle({ drainTimeoutMs: 50 });
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      timeout: 100,
      onExit: (code) => {
        exitCode = code;
      },
      hardKill: () => {
        throw new Error("hardKill threw on timeout");
      },
      run: async function* () {
        yield "start";
        await new Promise<never>(() => {});
      },
    };
    const task = await shortDrainLifecycle.start(taskItemId("task_16"), output, config);
    runningTasks.push(task);

    // Should not throw despite hardKill throwing in the timeout callback
    await new Promise((resolve) => setTimeout(resolve, 250));
    runningTasks.pop();

    // onExit still fires correctly despite hardKill failure
    expect(exitCode).toBe(1);
  });

  test("stuck agent without hardKill emits cleanup-incomplete message and fires onExit", async () => {
    const shortDrainLifecycle = createLocalAgentLifecycle({ drainTimeoutMs: 50 });
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      timeout: 100,
      onExit: (code) => {
        exitCode = code;
      },
      run: async function* () {
        yield "start";
        await new Promise<never>(() => {}); // permanently stuck, no hardKill
      },
    };
    await shortDrainLifecycle.start(taskItemId("task_17"), output, config);

    // Wait past timeout + drain: 100 + 50 = 150ms (no post-hardKill wait, no hardKill)
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(exitCode).toBe(1);
    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    // No hardKill means cleanup cannot be confirmed — distinct message
    expect(combined).toContain("[timed out: cleanup incomplete]");
  });

  test("inputs are forwarded to run callback", async () => {
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

  test("synchronous run() throw emits [error:] marker and fires onExit(1)", async () => {
    const output = createOutputStream();
    let exitCode: number | undefined;
    const config: LocalAgentConfig = {
      agentType: "worker",
      inputs: {},
      onExit: (code) => {
        exitCode = code;
      },
      run: () => {
        throw new Error("setup failed");
      },
    };

    // start() must resolve (not reject) and return a usable task
    const task = await lifecycle.start(taskItemId("task_18"), output, config);
    expect(task.kind).toBe("local_agent");

    const combined = output
      .read(0)
      .map((c) => c.content)
      .join("");
    expect(combined).toContain("[error: setup failed]");
    expect(exitCode).toBe(1);
  });
});

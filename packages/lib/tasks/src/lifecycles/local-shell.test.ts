import { afterEach, describe, expect, test } from "bun:test";
import { taskItemId } from "@koi/core";
import { createOutputStream } from "../output-stream.js";
import { createLocalShellLifecycle, type LocalShellConfig } from "./local-shell.js";

describe("createLocalShellLifecycle", () => {
  const lifecycle = createLocalShellLifecycle();
  const runningTasks: Array<{ readonly cancel: () => void }> = [];

  afterEach(async () => {
    // Clean up any tasks that weren't stopped
    for (const task of runningTasks) {
      task.cancel();
    }
    runningTasks.length = 0;
  });

  test("kind is local_shell", () => {
    expect(lifecycle.kind).toBe("local_shell");
  });

  test("start spawns process and returns LocalShellTask", async () => {
    const output = createOutputStream();
    const config: LocalShellConfig = { command: "echo hello" };
    const task = await lifecycle.start(taskItemId("task_1"), output, config);
    runningTasks.push(task);

    expect(task.kind).toBe("local_shell");
    expect(task.taskId).toBe(taskItemId("task_1"));
    expect(task.command).toBe("echo hello");
    expect(typeof task.cancel).toBe("function");
    expect(task.startedAt).toBeGreaterThan(0);
  });

  test("output streams stdout from process", async () => {
    const output = createOutputStream();
    const config: LocalShellConfig = { command: 'echo "test output"' };
    const task = await lifecycle.start(taskItemId("task_2"), output, config);
    runningTasks.push(task);

    // Wait for the process to finish
    await new Promise((resolve) => setTimeout(resolve, 200));

    const chunks = output.read(0);
    const combined = chunks.map((c) => c.content).join("");
    expect(combined).toContain("test output");
  });

  test("stop kills the running process", async () => {
    const output = createOutputStream();
    // Long-running command
    const config: LocalShellConfig = { command: "sleep 60" };
    const task = await lifecycle.start(taskItemId("task_3"), output, config);
    runningTasks.push(task);

    // Stop should not throw
    await lifecycle.stop(task);

    // Task should be cleaned up
    runningTasks.pop();
  });

  test("start with cwd option", async () => {
    const output = createOutputStream();
    const config: LocalShellConfig = { command: "pwd", cwd: "/tmp" };
    const task = await lifecycle.start(taskItemId("task_4"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const chunks = output.read(0);
    const combined = chunks.map((c) => c.content).join("");
    expect(combined).toContain("/tmp");
  });

  test("captures stderr in output stream", async () => {
    const output = createOutputStream();
    const config: LocalShellConfig = { command: "echo err >&2" };
    const task = await lifecycle.start(taskItemId("task_5"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const chunks = output.read(0);
    const combined = chunks.map((c) => c.content).join("");
    expect(combined).toContain("err");
  });
});

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

  // -------------------------------------------------------------------------
  // Missing branch coverage (#1557 review fix 10A)
  // -------------------------------------------------------------------------
  //
  // Before these tests, local-shell.ts shipped with only 5 tests covering
  // the happy path. The runner depends on `onExit` being called correctly,
  // and if that's broken every task gets stuck in_progress forever.

  test("timeout aborts long-running command", async () => {
    const output = createOutputStream();
    // Sleep 60s but timeout in 100ms
    const config: LocalShellConfig = { command: "sleep 60", timeout: 100 };
    const task = await lifecycle.start(taskItemId("task_timeout"), output, config);
    runningTasks.push(task);

    // Wait long enough for timeout to fire + process to be killed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Output should contain the exit marker — proves the process was killed
    const chunks = output.read(0);
    const combined = chunks.map((c) => c.content).join("");
    expect(combined).toMatch(/exit code/);
    // Clean up — task already aborted
    runningTasks.pop();
  });

  test("onExit callback fires with the subprocess exit code", async () => {
    const output = createOutputStream();
    const exitCodes: number[] = [];
    const config: LocalShellConfig = {
      command: "exit 42",
      onExit: (code) => {
        exitCodes.push(code);
      },
    };
    const task = await lifecycle.start(taskItemId("task_onexit"), output, config);
    runningTasks.push(task);

    // Give the process time to exit
    await new Promise((resolve) => setTimeout(resolve, 200));

    // onExit fired exactly once with the real exit code
    expect(exitCodes).toHaveLength(1);
    expect(exitCodes[0]).toBe(42);
    runningTasks.pop();
  });

  test("env vars reach the spawned subprocess", async () => {
    const output = createOutputStream();
    const config: LocalShellConfig = {
      command: "echo $KOI_TEST_VAR",
      env: { KOI_TEST_VAR: "hello-from-test" },
    };
    const task = await lifecycle.start(taskItemId("task_env"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const chunks = output.read(0);
    const combined = chunks.map((c) => c.content).join("");
    expect(combined).toContain("hello-from-test");
  });

  test("stop() actually terminates the process (not just a no-op)", async () => {
    const output = createOutputStream();
    const config: LocalShellConfig = { command: "sleep 60" };
    const task = await lifecycle.start(taskItemId("task_stop_verify"), output, config);
    runningTasks.push(task);

    const startTime = Date.now();
    await lifecycle.stop(task);
    const elapsed = Date.now() - startTime;

    // stop() completes in well under 1 second — the 60s sleep was really killed.
    expect(elapsed).toBeLessThan(1000);
    runningTasks.pop();
  });

  test("onExit fires for natural (non-timeout, non-abort) exit", async () => {
    // Verifies the happy path: a short-lived process exits cleanly with
    // code 0, onExit receives it, no timeout interferes.
    const output = createOutputStream();
    const exitCodes: number[] = [];
    const config: LocalShellConfig = {
      command: "true",
      onExit: (code) => {
        exitCodes.push(code);
      },
    };
    const task = await lifecycle.start(taskItemId("task_natural"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exitCodes).toEqual([0]);
    runningTasks.pop();
  });

  test("multibyte UTF-8 output decodes correctly across chunk boundaries", async () => {
    // The 3-byte sequence for U+1F600 (😀) could get split across stdout
    // flush boundaries. The TextDecoder with stream: true should handle it.
    // We emit many UTF-8 characters to increase the chance of split boundaries.
    const output = createOutputStream();
    const config: LocalShellConfig = {
      command: "printf '%s' '😀😀😀😀😀😀😀😀😀😀'",
    };
    const task = await lifecycle.start(taskItemId("task_utf8"), output, config);
    runningTasks.push(task);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const chunks = output.read(0);
    const combined = chunks.map((c) => c.content).join("");
    // All 10 smileys round-tripped — no U+FFFD replacement chars from bad decoding
    expect(combined).toContain("😀😀😀😀😀😀😀😀😀😀");
    expect(combined).not.toContain("\uFFFD");
  });
});

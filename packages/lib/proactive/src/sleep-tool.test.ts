import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import { createSleepTool } from "./sleep-tool.js";
import { createSchedulerStub } from "./test-helpers.js";
import { DEFAULT_MAX_SLEEP_MS, DEFAULT_WAKE_MESSAGE } from "./types.js";

function exec(tool: ReturnType<typeof createSleepTool>, args: JsonObject): Promise<unknown> {
  return tool.execute(args);
}

describe("sleep tool", () => {
  test("submits a delayed dispatch and returns task id + absolute wake_at", async () => {
    const stub = createSchedulerStub();
    const fixedNow = 1_700_000_000_000;
    const tool = createSleepTool({ scheduler: stub.component, now: () => fixedNow });

    const result = (await exec(tool, { duration_ms: 5000 })) as {
      ok: boolean;
      task_id: string;
      wake_at_ms: number;
    };

    expect(result.ok).toBe(true);
    expect(result.task_id).toBe("task-1");
    expect(result.wake_at_ms).toBe(fixedNow + 5000);
    expect(stub.submitCalls).toHaveLength(1);
    expect(stub.submitCalls[0]?.mode).toBe("dispatch");
    expect(stub.submitCalls[0]?.options?.delayMs).toBe(5000);
    expect(stub.submitCalls[0]?.input).toEqual({
      kind: "text",
      text: DEFAULT_WAKE_MESSAGE,
    });
  });

  test("uses caller-supplied wake_message when provided", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, {
      duration_ms: 1000,
      wake_message: "morning standup time",
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(stub.submitCalls[0]?.input).toEqual({
      kind: "text",
      text: "morning standup time",
    });
  });

  test("uses configured defaultWakeMessage when caller omits one", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({
      scheduler: stub.component,
      defaultWakeMessage: "custom default",
    });

    await exec(tool, { duration_ms: 100 });

    expect(stub.submitCalls[0]?.input).toEqual({ kind: "text", text: "custom default" });
  });

  test("rejects non-positive duration without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { duration_ms: 0 })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("duration_ms");
    expect(stub.submitCalls).toHaveLength(0);
  });

  test("rejects non-integer duration without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { duration_ms: 1.5 })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.submitCalls).toHaveLength(0);
  });

  test("rejects duration above maxSleepMs without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component, maxSleepMs: 10_000 });

    const result = (await exec(tool, { duration_ms: 10_001 })) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds maxSleepMs");
    expect(stub.submitCalls).toHaveLength(0);
  });

  test("default maxSleepMs is 24h and accepts boundary value", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { duration_ms: DEFAULT_MAX_SLEEP_MS })) as {
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(stub.submitCalls).toHaveLength(1);
  });

  test("returns ok:false when scheduler.submit throws", async () => {
    const stub = createSchedulerStub({ submitError: new Error("queue full") });
    const tool = createSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { duration_ms: 100 })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("queue full");
  });

  test("rejects empty wake_message", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { duration_ms: 100, wake_message: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.submitCalls).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import { scheduleId } from "@koi/core";
import { createCancelScheduleTool, createScheduleCronTool } from "./cron-tools.js";
import { createSchedulerStub } from "./test-helpers.js";
import { DEFAULT_WAKE_MESSAGE } from "./types.js";

function exec(
  tool: { readonly execute: (args: JsonObject) => Promise<unknown> },
  args: JsonObject,
): Promise<unknown> {
  return tool.execute(args);
}

describe("schedule_cron tool", () => {
  test("forwards expression and default wake message; returns schedule id", async () => {
    const stub = createSchedulerStub();
    const tool = createScheduleCronTool({ scheduler: stub.component });

    const result = (await exec(tool, { expression: "0 9 * * 1-5" })) as {
      ok: boolean;
      schedule_id: string;
    };

    expect(result.ok).toBe(true);
    expect(result.schedule_id).toBe("sched-1");
    expect(stub.scheduleCalls).toHaveLength(1);
    const call = stub.scheduleCalls[0];
    expect(call?.expression).toBe("0 9 * * 1-5");
    expect(call?.mode).toBe("dispatch");
    expect(call?.input).toEqual({ kind: "text", text: DEFAULT_WAKE_MESSAGE });
    expect(call?.options).toBeUndefined();
  });

  test("forwards timezone option when supplied", async () => {
    const stub = createSchedulerStub();
    const tool = createScheduleCronTool({ scheduler: stub.component });

    await exec(tool, { expression: "0 0 * * *", timezone: "America/Los_Angeles" });

    expect(stub.scheduleCalls[0]?.options).toEqual({ timezone: "America/Los_Angeles" });
  });

  test("uses caller-supplied wake_message", async () => {
    const stub = createSchedulerStub();
    const tool = createScheduleCronTool({ scheduler: stub.component });

    await exec(tool, { expression: "*/5 * * * *", wake_message: "poll inbox" });

    expect(stub.scheduleCalls[0]?.input).toEqual({ kind: "text", text: "poll inbox" });
  });

  test("rejects empty expression without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createScheduleCronTool({ scheduler: stub.component });

    const result = (await exec(tool, { expression: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.scheduleCalls).toHaveLength(0);
  });

  test("returns ok:false when scheduler rejects expression", async () => {
    const stub = createSchedulerStub({ scheduleError: new Error("invalid cron") });
    const tool = createScheduleCronTool({ scheduler: stub.component });

    const result = (await exec(tool, { expression: "not-a-cron" })) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid cron");
  });
});

describe("cancel_schedule tool", () => {
  test("forwards schedule id and returns scheduler removed flag", async () => {
    const stub = createSchedulerStub();
    const tool = createCancelScheduleTool({ scheduler: stub.component });

    const result = (await exec(tool, { schedule_id: "sched-42" })) as {
      ok: boolean;
      removed: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(stub.unscheduleCalls).toEqual([scheduleId("sched-42")]);
  });

  test("returns removed:false for unknown id without throwing", async () => {
    const stub = createSchedulerStub({ unscheduleResult: false });
    const tool = createCancelScheduleTool({ scheduler: stub.component });

    const result = (await exec(tool, { schedule_id: "missing" })) as {
      ok: boolean;
      removed: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("rejects empty schedule_id without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createCancelScheduleTool({ scheduler: stub.component });

    const result = (await exec(tool, { schedule_id: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.unscheduleCalls).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import { scheduleId } from "@koi/core";
import {
  createCancelScheduleTool,
  createCronToolState,
  createScheduleCronTool,
} from "./cron-tools.js";
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
    const tool = createScheduleCronTool({ scheduler: stub.component }, createCronToolState());

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
    const tool = createScheduleCronTool({ scheduler: stub.component }, createCronToolState());

    await exec(tool, { expression: "0 0 * * *", timezone: "America/Los_Angeles" });

    expect(stub.scheduleCalls[0]?.options).toEqual({ timezone: "America/Los_Angeles" });
  });

  test("uses caller-supplied wake_message", async () => {
    const stub = createSchedulerStub();
    const tool = createScheduleCronTool({ scheduler: stub.component }, createCronToolState());

    await exec(tool, { expression: "*/5 * * * *", wake_message: "poll inbox" });

    expect(stub.scheduleCalls[0]?.input).toEqual({ kind: "text", text: "poll inbox" });
  });

  test("rejects empty expression without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createScheduleCronTool({ scheduler: stub.component }, createCronToolState());

    const result = (await exec(tool, { expression: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.scheduleCalls).toHaveLength(0);
  });

  test("returns ok:false when scheduler rejects expression", async () => {
    const stub = createSchedulerStub({ scheduleError: new Error("invalid cron") });
    const tool = createScheduleCronTool({ scheduler: stub.component }, createCronToolState());

    const result = (await exec(tool, { expression: "not-a-cron" })) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid cron");
  });

  test("dedupes by idempotency_key — second call returns same id without re-scheduling", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    const first = (await exec(tool, {
      expression: "0 9 * * 1-5",
      idempotency_key: "morning-standup",
    })) as { ok: boolean; schedule_id: string };
    const second = (await exec(tool, {
      expression: "0 9 * * 1-5",
      idempotency_key: "morning-standup",
    })) as { ok: boolean; schedule_id: string; deduped?: boolean };

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.schedule_id).toBe(first.schedule_id);
    expect(second.deduped).toBe(true);
    expect(stub.scheduleCalls).toHaveLength(1);
  });

  test("idempotency_key collision with different expression fails closed", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    await exec(tool, { expression: "0 9 * * 1-5", idempotency_key: "k" });
    const collided = (await exec(tool, {
      expression: "0 10 * * 1-5",
      idempotency_key: "k",
    })) as { ok: boolean; error: string };

    expect(collided.ok).toBe(false);
    expect(collided.error).toContain("already registered");
    expect(stub.scheduleCalls).toHaveLength(1);
  });

  test("idempotency_key collision with different timezone fails closed", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    await exec(tool, {
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
      idempotency_key: "k",
    });
    const collided = (await exec(tool, {
      expression: "0 9 * * *",
      timezone: "America/New_York",
      idempotency_key: "k",
    })) as { ok: boolean };

    expect(collided.ok).toBe(false);
    expect(stub.scheduleCalls).toHaveLength(1);
  });

  test("does NOT forward idempotency_key to scheduler.schedule (Temporal rejects it)", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    await exec(tool, {
      expression: "0 9 * * *",
      timezone: "UTC",
      idempotency_key: "k",
    });

    const opts = stub.scheduleCalls[0]?.options as
      | { timezone?: string; idempotencyKey?: string }
      | undefined;
    expect(opts?.idempotencyKey).toBeUndefined();
    expect(opts?.timezone).toBe("UTC");
  });

  test("rejects new idempotency_key when cron cap is reached (no live-schedule eviction)", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState(2);
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    await exec(tool, { expression: "0 9 * * *", idempotency_key: "a" });
    await exec(tool, { expression: "0 9 * * *", idempotency_key: "b" });

    const overflow = (await exec(tool, {
      expression: "0 9 * * *",
      idempotency_key: "c",
    })) as { ok: boolean; error: string };

    expect(overflow.ok).toBe(false);
    expect(overflow.error).toContain("cap reached");
    expect(stub.scheduleCalls).toHaveLength(2);
    // Both prior keys must remain mapped — duplicates would let a retry
    // register a second live recurring schedule.
    expect(state.idempotencyMap.has("a")).toBe(true);
    expect(state.idempotencyMap.has("b")).toBe(true);
  });

  test("at the cap, an existing key still dedupes (update, not new entry)", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState(1);
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    await exec(tool, { expression: "0 9 * * *", idempotency_key: "a" });
    const replay = (await exec(tool, {
      expression: "0 9 * * *",
      idempotency_key: "a",
    })) as { ok: boolean; deduped?: boolean };

    expect(replay.ok).toBe(true);
    expect(replay.deduped).toBe(true);
  });

  test("rejects idempotency_key containing ':' (Temporal stable-id delimiter)", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    const result = (await exec(tool, {
      expression: "0 9 * * *",
      idempotency_key: "bad:key",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(stub.scheduleCalls).toHaveLength(0);
  });

  test("concurrent same-key calls share one registration", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    const [a, b, c] = (await Promise.all([
      exec(tool, { expression: "0 9 * * *", idempotency_key: "k" }),
      exec(tool, { expression: "0 9 * * *", idempotency_key: "k" }),
      exec(tool, { expression: "0 9 * * *", idempotency_key: "k" }),
    ])) as { ok: boolean; schedule_id: string }[];

    expect(stub.scheduleCalls).toHaveLength(1);
    expect(a?.schedule_id).toBe(b?.schedule_id);
    expect(b?.schedule_id).toBe(c?.schedule_id);
  });

  test("failed pending registration frees the key for retry", async () => {
    const failing = createSchedulerStub({ scheduleError: new Error("invalid cron") });
    const state = createCronToolState();
    const failTool = createScheduleCronTool({ scheduler: failing.component }, state);

    const failed = (await exec(failTool, {
      expression: "0 9 * * *",
      idempotency_key: "k",
    })) as { ok: boolean };
    expect(failed.ok).toBe(false);

    const ok = createSchedulerStub();
    const okTool = createScheduleCronTool({ scheduler: ok.component }, state);
    const retried = (await exec(okTool, {
      expression: "0 9 * * *",
      idempotency_key: "k",
    })) as { ok: boolean };

    expect(retried.ok).toBe(true);
    expect(ok.scheduleCalls).toHaveLength(1);
  });

  test("distinct idempotency_keys produce distinct schedules", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const tool = createScheduleCronTool({ scheduler: stub.component }, state);

    await exec(tool, { expression: "0 9 * * 1-5", idempotency_key: "a" });
    await exec(tool, { expression: "0 9 * * 1-5", idempotency_key: "b" });

    expect(stub.scheduleCalls).toHaveLength(2);
  });
});

describe("cancel_schedule tool", () => {
  test("forwards schedule id and returns scheduler removed flag", async () => {
    const stub = createSchedulerStub();
    const tool = createCancelScheduleTool({ scheduler: stub.component }, createCronToolState());

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
    const tool = createCancelScheduleTool({ scheduler: stub.component }, createCronToolState());

    const result = (await exec(tool, { schedule_id: "missing" })) as {
      ok: boolean;
      removed: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("rejects empty schedule_id without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createCancelScheduleTool({ scheduler: stub.component }, createCronToolState());

    const result = (await exec(tool, { schedule_id: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.unscheduleCalls).toHaveLength(0);
  });

  test("clears idempotency mapping on successful unschedule so a fresh key reuse re-schedules", async () => {
    const stub = createSchedulerStub();
    const state = createCronToolState();
    const cron = createScheduleCronTool({ scheduler: stub.component }, state);
    const cancel = createCancelScheduleTool({ scheduler: stub.component }, state);

    const first = (await exec(cron, {
      expression: "*/5 * * * *",
      idempotency_key: "poll",
    })) as { schedule_id: string };

    await exec(cancel, { schedule_id: first.schedule_id });

    const reissued = (await exec(cron, {
      expression: "*/5 * * * *",
      idempotency_key: "poll",
    })) as { schedule_id: string; deduped?: boolean };

    expect(reissued.deduped).toBeUndefined();
    expect(stub.scheduleCalls).toHaveLength(2);
  });

  test("preserves idempotency mapping when unschedule returns false (no release_key)", async () => {
    const failing = createSchedulerStub({ unscheduleResult: false });
    const state = createCronToolState();
    const cron = createScheduleCronTool({ scheduler: failing.component }, state);
    const cancel = createCancelScheduleTool({ scheduler: failing.component }, state);

    const first = (await exec(cron, {
      expression: "*/5 * * * *",
      idempotency_key: "poll",
    })) as { schedule_id: string };

    await exec(cancel, { schedule_id: first.schedule_id });

    // The remote schedule may still exist — replay must dedupe to the
    // existing schedule_id rather than register a duplicate.
    const replay = (await exec(cron, {
      expression: "*/5 * * * *",
      idempotency_key: "poll",
    })) as { schedule_id: string; deduped?: boolean };

    expect(replay.schedule_id).toBe(first.schedule_id);
    expect(replay.deduped).toBe(true);
    expect(failing.scheduleCalls).toHaveLength(1);
  });

  test("release_key clears idempotency mapping even on removed:false", async () => {
    const stub = createSchedulerStub({ unscheduleResult: false });
    const state = createCronToolState();
    const cron = createScheduleCronTool({ scheduler: stub.component }, state);
    const cancel = createCancelScheduleTool({ scheduler: stub.component }, state);

    const first = (await exec(cron, {
      expression: "*/5 * * * *",
      idempotency_key: "poll",
    })) as { schedule_id: string };

    await exec(cancel, { schedule_id: first.schedule_id, release_key: true });

    const reissued = (await exec(cron, {
      expression: "*/5 * * * *",
      idempotency_key: "poll",
    })) as { deduped?: boolean };

    expect(reissued.deduped).toBeUndefined();
    expect(stub.scheduleCalls).toHaveLength(2);
  });
});

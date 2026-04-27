import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import { createSleepTool, createSleepToolState } from "./sleep-tool.js";
import { createSchedulerStub } from "./test-helpers.js";
import { DEFAULT_MAX_SLEEP_MS, DEFAULT_WAKE_MESSAGE } from "./types.js";

function exec(tool: ReturnType<typeof createSleepTool>, args: JsonObject): Promise<unknown> {
  return tool.execute(args);
}

describe("sleep tool", () => {
  test("submits a delayed dispatch and returns task id + absolute wake_at", async () => {
    const stub = createSchedulerStub();
    const fixedNow = 1_700_000_000_000;
    const tool = createSleepTool(
      { scheduler: stub.component, now: () => fixedNow },
      createSleepToolState(),
    );

    const result = (await exec(tool, { duration_ms: 5000 })) as {
      ok: boolean;
      task_id: string;
      wake_at_ms: number;
    };

    expect(result.ok).toBe(true);
    expect(result.task_id).toBe("task-1");
    expect(result.wake_at_ms).toBe(fixedNow + 5000);
    expect(stub.submitCalls).toHaveLength(1);
    expect(stub.submitCalls[0]?.mode).toBe("spawn");
    expect(stub.submitCalls[0]?.options?.delayMs).toBe(5000);
    expect(stub.submitCalls[0]?.input).toEqual({
      kind: "text",
      text: DEFAULT_WAKE_MESSAGE,
    });
  });

  test("uses caller-supplied wake_message when provided", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component }, createSleepToolState());

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
    const tool = createSleepTool(
      { scheduler: stub.component, defaultWakeMessage: "custom default" },
      createSleepToolState(),
    );

    await exec(tool, { duration_ms: 100 });

    expect(stub.submitCalls[0]?.input).toEqual({ kind: "text", text: "custom default" });
  });

  test("rejects non-positive duration without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component }, createSleepToolState());

    const result = (await exec(tool, { duration_ms: 0 })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("duration_ms");
    expect(stub.submitCalls).toHaveLength(0);
  });

  test("rejects non-integer duration without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component }, createSleepToolState());

    const result = (await exec(tool, { duration_ms: 1.5 })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.submitCalls).toHaveLength(0);
  });

  test("rejects duration above maxSleepMs without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool(
      { scheduler: stub.component, maxSleepMs: 10_000 },
      createSleepToolState(),
    );

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
    const tool = createSleepTool({ scheduler: stub.component }, createSleepToolState());

    const result = (await exec(tool, { duration_ms: DEFAULT_MAX_SLEEP_MS })) as {
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(stub.submitCalls).toHaveLength(1);
  });

  test("returns ok:false when scheduler.submit throws", async () => {
    const stub = createSchedulerStub({ submitError: new Error("queue full") });
    const tool = createSleepTool({ scheduler: stub.component }, createSleepToolState());

    const result = (await exec(tool, { duration_ms: 100 })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("queue full");
  });

  test("rejects empty wake_message", async () => {
    const stub = createSchedulerStub();
    const tool = createSleepTool({ scheduler: stub.component }, createSleepToolState());

    const result = (await exec(tool, { duration_ms: 100, wake_message: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.submitCalls).toHaveLength(0);
  });

  test("dedupes by idempotency_key — second call with matching fields returns same task_id", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState();
    const fixedNow = 1_700_000_000_000;
    const tool = createSleepTool({ scheduler: stub.component, now: () => fixedNow }, state);

    const first = (await exec(tool, {
      duration_ms: 5_000,
      idempotency_key: "poll-job-42",
    })) as { task_id: string; wake_at_ms: number };
    const second = (await exec(tool, {
      duration_ms: 5_000,
      idempotency_key: "poll-job-42",
    })) as { task_id: string; wake_at_ms: number; deduped?: boolean };

    expect(second.task_id).toBe(first.task_id);
    expect(second.wake_at_ms).toBe(first.wake_at_ms);
    expect(second.deduped).toBe(true);
    expect(stub.submitCalls).toHaveLength(1);
  });

  test("idempotency_key collision with different duration fails closed", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState();
    const tool = createSleepTool({ scheduler: stub.component }, state);

    await exec(tool, { duration_ms: 5_000, idempotency_key: "k" });
    const collided = (await exec(tool, { duration_ms: 9_000, idempotency_key: "k" })) as {
      ok: boolean;
      error: string;
    };

    expect(collided.ok).toBe(false);
    expect(collided.error).toContain("already registered");
    expect(stub.submitCalls).toHaveLength(1);
  });

  test("idempotency_key collision with different wake_message fails closed", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState();
    const tool = createSleepTool({ scheduler: stub.component }, state);

    await exec(tool, { duration_ms: 5_000, wake_message: "first", idempotency_key: "k" });
    const collided = (await exec(tool, {
      duration_ms: 5_000,
      wake_message: "second",
      idempotency_key: "k",
    })) as { ok: boolean };

    expect(collided.ok).toBe(false);
    expect(stub.submitCalls).toHaveLength(1);
  });

  test("entries persist across wake_at_ms — wall-clock expiry would risk duplicates", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState();
    // let justified: virtual clock advances between calls to simulate time passing
    let virtualNow = 1_000_000;
    const tool = createSleepTool({ scheduler: stub.component, now: () => virtualNow }, state);

    const first = (await exec(tool, { duration_ms: 5_000, idempotency_key: "k" })) as {
      task_id: string;
    };
    virtualNow += 6_000; // wake time has passed but no completion signal received
    const second = (await exec(tool, { duration_ms: 5_000, idempotency_key: "k" })) as {
      task_id: string;
      deduped?: boolean;
    };

    // The package never expires entries on time alone — a backlogged scheduler
    // could still deliver the original. The second call must dedupe.
    expect(second.task_id).toBe(first.task_id);
    expect(second.deduped).toBe(true);
    expect(stub.submitCalls).toHaveLength(1);
  });

  test("concurrent same-key calls share one submission", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState();
    const tool = createSleepTool({ scheduler: stub.component }, state);

    const [a, b, c] = (await Promise.all([
      exec(tool, { duration_ms: 5_000, idempotency_key: "k" }),
      exec(tool, { duration_ms: 5_000, idempotency_key: "k" }),
      exec(tool, { duration_ms: 5_000, idempotency_key: "k" }),
    ])) as { ok: boolean; task_id: string }[];

    expect(stub.submitCalls).toHaveLength(1);
    expect(a?.task_id).toBe(b?.task_id);
    expect(b?.task_id).toBe(c?.task_id);
  });

  test("forwards idempotency_key as TaskOptions.idempotencyKey to scheduler.submit", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState();
    const tool = createSleepTool({ scheduler: stub.component }, state);

    await exec(tool, { duration_ms: 5_000, idempotency_key: "k" });

    expect(stub.submitCalls[0]?.options?.idempotencyKey).toBe("k");
    expect(stub.submitCalls[0]?.options?.delayMs).toBe(5_000);
  });

  test("rejects new idempotency_key when sleep cap is reached (no live-task eviction)", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState(2);
    const tool = createSleepTool({ scheduler: stub.component }, state);

    await exec(tool, { duration_ms: 1_000, idempotency_key: "a" });
    await exec(tool, { duration_ms: 1_000, idempotency_key: "b" });
    const blocked = (await exec(tool, { duration_ms: 1_000, idempotency_key: "c" })) as {
      ok: boolean;
      error?: string;
    };

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("cap reached");
    expect(state.idempotencyMap.has("a")).toBe(true);
    expect(state.idempotencyMap.has("b")).toBe(true);
    expect(state.idempotencyMap.has("c")).toBe(false);
    // Only the two pre-cap submits made it to the scheduler — the 3rd
    // failed closed rather than silently registering a duplicate-prone task.
    expect(stub.submitCalls).toHaveLength(2);
  });

  test("at the cap, an existing key still dedupes (update, not new entry)", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState(2);
    const tool = createSleepTool({ scheduler: stub.component }, state);

    const r1 = (await exec(tool, { duration_ms: 1_000, idempotency_key: "a" })) as {
      task_id: string;
    };
    await exec(tool, { duration_ms: 1_000, idempotency_key: "b" });
    const r2 = (await exec(tool, { duration_ms: 1_000, idempotency_key: "a" })) as {
      task_id: string;
      deduped?: boolean;
    };

    expect(r2.task_id).toBe(r1.task_id);
    expect(r2.deduped).toBe(true);
    expect(stub.submitCalls).toHaveLength(2);
  });

  test("rejects idempotency_key containing ':' (Temporal stable-id delimiter)", async () => {
    const stub = createSchedulerStub();
    const state = createSleepToolState();
    const tool = createSleepTool({ scheduler: stub.component }, state);

    const result = (await exec(tool, {
      duration_ms: 5_000,
      idempotency_key: "bad:key",
    })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.submitCalls).toHaveLength(0);
  });

  test("failed pending submission frees the key for retry", async () => {
    const stub = createSchedulerStub({ submitError: new Error("transient") });
    const state = createSleepToolState();
    const tool = createSleepTool({ scheduler: stub.component }, state);

    const failed = (await exec(tool, { duration_ms: 5_000, idempotency_key: "k" })) as {
      ok: boolean;
    };
    expect(failed.ok).toBe(false);

    const okStub = createSchedulerStub();
    const retryTool = createSleepTool({ scheduler: okStub.component }, state);
    const retried = (await exec(retryTool, {
      duration_ms: 5_000,
      idempotency_key: "k",
    })) as { ok: boolean };

    expect(retried.ok).toBe(true);
    expect(okStub.submitCalls).toHaveLength(1);
  });
});

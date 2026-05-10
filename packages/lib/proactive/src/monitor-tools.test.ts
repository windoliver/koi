import { describe, expect, test } from "bun:test";
import { type ScheduleId, type SchedulerComponent, scheduleId } from "@koi/core";
import {
  createCancelMonitorTool,
  createCreateMonitorTool,
  createListMonitorsTool,
  createMonitorToolState,
  createUpdateMonitorTool,
  formatMonitorWakeMessage,
} from "./monitor-tools.js";
import { createSchedulerStub } from "./test-helpers.js";

describe("monitor tools", () => {
  test("create_monitor stores a monitor and schedules a recurring wake", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo and GitHub state, then decide whether follow-up is warranted.",
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
      context_hint: "Look at scheduler/channel restoration issues first.",
      idempotency_key: "dep-watch",
    })) as { ok: boolean; monitor_id: string; schedule_id: string; deduped?: boolean };

    expect(created.ok).toBe(true);
    expect(created.deduped).toBeUndefined();
    expect(stub.scheduleCalls).toHaveLength(1);
    expect(stub.scheduleCalls[0]?.expression).toBe("0 9 * * *");
    expect(stub.scheduleCalls[0]?.mode).toBe("dispatch");
    expect(stub.scheduleCalls[0]?.input).toEqual({
      kind: "text",
      text: [
        "Monitor check: dependency-watch",
        "Goal: Detect whether issue #1212 is unblocked",
        "Check: Inspect repo and GitHub state, then decide whether follow-up is warranted.",
        "Context: Look at scheduler/channel restoration issues first.",
      ].join("\n"),
    });
    expect(stub.scheduleCalls[0]?.options).toEqual({ timezone: "America/Los_Angeles" });

    const listed = (await listMonitors.execute({})) as {
      ok: boolean;
      monitors: {
        monitor_id: string;
        name: string;
        goal: string;
        expression: string;
        context_hint?: string;
        schedule_id: string;
      }[];
    };
    expect(listed.monitors).toHaveLength(1);
    expect(listed.monitors[0]).toEqual({
      monitor_id: created.monitor_id,
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      expression: "0 9 * * *",
      context_hint: "Look at scheduler/channel restoration issues first.",
      schedule_id: created.schedule_id,
    });
    expect(listed.monitors[0]).not.toHaveProperty("check_prompt");
  });

  test("create_monitor dedupes same-process identical idempotency_key", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);

    const args = {
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
      idempotency_key: "dep-watch",
    };

    const first = (await createMonitor.execute(args)) as {
      monitor_id: string;
      schedule_id: string;
    };
    const second = (await createMonitor.execute(args)) as {
      monitor_id: string;
      schedule_id: string;
      deduped?: boolean;
    };

    expect(second.monitor_id).toBe(first.monitor_id);
    expect(second.schedule_id).toBe(first.schedule_id);
    expect(second.deduped).toBe(true);
    expect(stub.scheduleCalls).toHaveLength(1);
  });

  test("create_monitor rejects a reused idempotency_key when monitor fields differ", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);

    await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
      idempotency_key: "dep-watch",
    });

    const mismatch = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      timezone: "America/New_York",
      idempotency_key: "dep-watch",
    })) as { ok: boolean; error: string };

    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toContain("already registered");
  });

  test("create_monitor validates required fields before touching the scheduler", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);

    const invalid = (await createMonitor.execute({
      name: "",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
    })) as { ok: boolean; error: string };

    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("name");
    expect(stub.scheduleCalls).toHaveLength(0);
  });

  test("list_monitors returns summary fields without exposing check_prompt", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      context_hint: "Look at scheduler/channel restoration issues first.",
    })) as { monitor_id: string; schedule_id: string };

    const listed = (await listMonitors.execute({})) as {
      monitors: {
        monitor_id: string;
        name: string;
        goal: string;
        expression: string;
        context_hint?: string;
        schedule_id: string;
      }[];
    };

    expect(listed.monitors).toEqual([
      {
        monitor_id: created.monitor_id,
        name: "dependency-watch",
        goal: "Detect whether issue #1212 is unblocked",
        expression: "0 9 * * *",
        context_hint: "Look at scheduler/channel restoration issues first.",
        schedule_id: created.schedule_id,
      },
    ]);
  });

  test("create_monitor clears its reservation after a failed scheduler create", async () => {
    const state = createMonitorToolState();
    const failingStub = createSchedulerStub({ scheduleError: new Error("scheduler unavailable") });
    const createMonitor = createCreateMonitorTool({ scheduler: failingStub.component }, state);
    const args = {
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    };

    const failed = (await createMonitor.execute(args)) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("scheduler unavailable");

    const workingStub = createSchedulerStub();
    const retryMonitor = createCreateMonitorTool({ scheduler: workingStub.component }, state);
    const retried = (await retryMonitor.execute(args)) as {
      ok: boolean;
      monitor_id: string;
      schedule_id: string;
      deduped?: boolean;
    };

    expect(retried.ok).toBe(true);
    expect(retried.deduped).toBeUndefined();
    expect(workingStub.scheduleCalls).toHaveLength(1);
  });

  test("update_monitor rotates the backing schedule and replaces stored fields", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
    })) as { monitor_id: string; schedule_id: string };

    const updated = (await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
      expression: "30 9 * * *",
      timezone: "America/New_York",
      context_hint: "Focus on delivery and durability work.",
    })) as { ok: boolean; monitor_id: string; schedule_id: string };

    expect(updated.ok).toBe(true);
    expect(updated.schedule_id).not.toBe(created.schedule_id);
    expect(stub.unscheduleCalls).toEqual([scheduleId(created.schedule_id)]);
    expect(stub.scheduleCalls[1]?.options).toEqual({ timezone: "America/New_York" });

    const listed = (await listMonitors.execute({})) as {
      monitors: {
        goal: string;
        expression: string;
        context_hint?: string;
        schedule_id: string;
      }[];
    };
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1301 is unblocked");
    expect(listed.monitors[0]?.expression).toBe("30 9 * * *");
    expect(listed.monitors[0]?.context_hint).toBe("Focus on delivery and durability work.");
    expect(listed.monitors[0]?.schedule_id).toBe(updated.schedule_id);
    expect(listed.monitors[0]).not.toHaveProperty("check_prompt");
  });

  test("update_monitor fails for an unknown monitor_id", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const updateMonitor = createUpdateMonitorTool({ scheduler: stub.component }, state);

    const result = (await updateMonitor.execute({
      monitor_id: "monitor-missing",
      goal: "Detect whether issue #1301 is unblocked",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    expect(stub.scheduleCalls).toHaveLength(0);
    expect(stub.unscheduleCalls).toHaveLength(0);
  });

  test("update_monitor preserves omitted fields by patch semantics", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      timezone: "UTC",
      context_hint: "Look at scheduler/channel restoration issues first.",
    })) as { monitor_id: string };

    await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
    });

    const listed = (await listMonitors.execute({})) as {
      monitors: { name: string; goal: string; expression: string; context_hint?: string }[];
    };
    expect(stub.scheduleCalls[1]?.options).toEqual({ timezone: "UTC" });
    expect(listed.monitors[0]?.name).toBe("dependency-watch");
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1301 is unblocked");
    expect(listed.monitors[0]?.expression).toBe("0 9 * * *");
    expect(listed.monitors[0]?.context_hint).toBe(
      "Look at scheduler/channel restoration issues first.",
    );
    expect(listed.monitors[0]).not.toHaveProperty("check_prompt");
  });

  test("update_monitor leaves the original record intact when replacement scheduling fails", async () => {
    const state = createMonitorToolState();
    const createStub = createSchedulerStub();
    const failingStub = createSchedulerStub({ scheduleError: new Error("scheduler unavailable") });
    const createMonitor = createCreateMonitorTool({ scheduler: createStub.component }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler: failingStub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
    })) as { monitor_id: string; schedule_id: string };

    const failed = (await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
    })) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("scheduler unavailable");
    expect(failingStub.unscheduleCalls).toHaveLength(0);
    expect(createStub.unscheduleCalls).toHaveLength(0);

    const listed = (await listMonitors.execute({})) as {
      monitors: { goal: string; schedule_id: string }[];
    };
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1212 is unblocked");
    expect(listed.monitors[0]?.schedule_id).toBe(created.schedule_id);
  });

  test("update_monitor compensates when retiring the original schedule reports false", async () => {
    const stub = createSchedulerStub({ unscheduleResult: false });
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
    })) as { monitor_id: string; schedule_id: string };

    const failed = (await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    })) as { ok: boolean; error: string };

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("retire previous monitor schedule");
    expect(stub.unscheduleCalls).toHaveLength(2);
    expect(stub.unscheduleCalls[0]).toBe(scheduleId(created.schedule_id));
    expect(String(stub.unscheduleCalls[1])).toBe("sched-2");

    const listed = (await listMonitors.execute({})) as {
      monitors: { goal: string; expression: string; schedule_id: string }[];
    };
    expect(listed.monitors).toHaveLength(1);
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1212 is unblocked");
    expect(listed.monitors[0]?.expression).toBe("0 9 * * *");
    expect(listed.monitors[0]?.schedule_id).toBe(created.schedule_id);
  });

  test("update_monitor compensates when retiring the original schedule throws", async () => {
    const stub = createSchedulerStub();
    let unscheduleAttempts = 0;
    const scheduler: SchedulerComponent = {
      ...stub.component,
      unschedule(id: ScheduleId) {
        stub.component.unschedule(id);
        unscheduleAttempts += 1;
        if (unscheduleAttempts === 1) {
          throw new Error("scheduler unavailable");
        }
        return true;
      },
    };
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
    })) as { monitor_id: string; schedule_id: string };

    const failed = (await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    })) as { ok: boolean; error: string };

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("scheduler unavailable");
    expect(stub.unscheduleCalls).toHaveLength(2);
    expect(stub.unscheduleCalls[0]).toBe(scheduleId(created.schedule_id));
    expect(String(stub.unscheduleCalls[1])).toBe("sched-2");

    const listed = (await listMonitors.execute({})) as {
      monitors: { goal: string; expression: string; schedule_id: string }[];
    };
    expect(listed.monitors).toHaveLength(1);
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1212 is unblocked");
    expect(listed.monitors[0]?.expression).toBe("0 9 * * *");
    expect(listed.monitors[0]?.schedule_id).toBe(created.schedule_id);
  });

  test("cancel_monitor removes the record and clears create-time idempotency", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const cancelMonitor = createCancelMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { monitor_id: string; schedule_id: string };

    const cancelled = (await cancelMonitor.execute({
      monitor_id: created.monitor_id,
    })) as { ok: boolean; removed: boolean };
    expect(cancelled).toEqual({ ok: true, removed: true });
    expect(stub.unscheduleCalls).toEqual([scheduleId(created.schedule_id)]);

    const listed = (await listMonitors.execute({})) as { monitors: unknown[] };
    expect(listed.monitors).toHaveLength(0);

    const recreated = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { monitor_id: string };
    expect(recreated.monitor_id).not.toBe(created.monitor_id);
  });

  test("cancel_monitor still removes known local state when unschedule reports false", async () => {
    const stub = createSchedulerStub({ unscheduleResult: false });
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const cancelMonitor = createCancelMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { monitor_id: string; schedule_id: string };

    const cancelled = (await cancelMonitor.execute({
      monitor_id: created.monitor_id,
    })) as { ok: boolean; removed: boolean };
    expect(cancelled).toEqual({ ok: true, removed: true });
    expect(stub.unscheduleCalls).toEqual([scheduleId(created.schedule_id)]);

    const listed = (await listMonitors.execute({})) as { monitors: unknown[] };
    expect(listed.monitors).toHaveLength(0);

    const recreated = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { monitor_id: string; deduped?: boolean };
    expect(recreated.monitor_id).not.toBe(created.monitor_id);
    expect(recreated.deduped).toBeUndefined();
  });

  test("cancel_monitor returns removed:false for an unknown monitor_id", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const cancelMonitor = createCancelMonitorTool({ scheduler: stub.component }, state);

    const result = await cancelMonitor.execute({ monitor_id: "monitor-missing" });
    expect(result).toEqual({ ok: true, removed: false });
  });

  test("formatMonitorWakeMessage renders deterministic multi-line text", () => {
    expect(
      formatMonitorWakeMessage({
        name: "dependency-watch",
        goal: "Detect whether issue #1212 is unblocked",
        checkPrompt: "Inspect repo and GitHub state, then decide whether follow-up is warranted.",
        contextHint: "Look at scheduler/channel restoration issues first.",
      }),
    ).toBe(
      [
        "Monitor check: dependency-watch",
        "Goal: Detect whether issue #1212 is unblocked",
        "Check: Inspect repo and GitHub state, then decide whether follow-up is warranted.",
        "Context: Look at scheduler/channel restoration issues first.",
      ].join("\n"),
    );
  });

  test("formatMonitorWakeMessage omits the Context line when no context hint is present", () => {
    expect(
      formatMonitorWakeMessage({
        name: "dependency-watch",
        goal: "Detect whether issue #1212 is unblocked",
        checkPrompt: "Inspect repo state.",
      }),
    ).toBe(
      [
        "Monitor check: dependency-watch",
        "Goal: Detect whether issue #1212 is unblocked",
        "Check: Inspect repo state.",
      ].join("\n"),
    );
  });

  test("scheduler stub tracks submitted task lifecycle and query helpers", async () => {
    const stub = createSchedulerStub();
    const task = await stub.component.submit({ kind: "text", text: "wake up" }, "spawn", {
      delayMs: 5_000,
    });

    expect(stub.submitCalls).toHaveLength(1);
    expect(stub.submitCalls[0]).toEqual({
      input: { kind: "text", text: "wake up" },
      mode: "spawn",
      options: { delayMs: 5_000 },
    });
    expect(stub.isLive(task)).toBe(true);
    expect(await stub.component.query({})).toEqual([
      {
        id: task,
        agentId: expect.any(String),
        input: { kind: "text", text: "" },
        mode: "spawn",
        priority: 0,
        status: "pending",
        createdAt: 0,
        retries: 0,
        maxRetries: 0,
      },
    ]);
    expect(await stub.component.pause(scheduleId("sched-pause"))).toBe(true);
    expect(await stub.component.resume(scheduleId("sched-pause"))).toBe(true);
    expect(await stub.component.stats()).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      deadLettered: 0,
      activeSchedules: 0,
      pausedSchedules: 0,
    });
    expect(await stub.component.history({})).toEqual([]);

    expect(await stub.component.cancel(task)).toBe(true);
    expect(stub.cancelCalls).toEqual([task]);
    expect(stub.isLive(task)).toBe(false);

    const retired = await stub.component.submit({ kind: "text", text: "retire me" }, "spawn");
    expect(stub.isLive(retired)).toBe(true);
    stub.retireTask(retired);
    expect(stub.isLive(retired)).toBe(false);
  });

  test("scheduler stub surfaces submit errors and non-removing cancels", async () => {
    const failingSubmit = createSchedulerStub({ submitError: new Error("queue full") });
    expect(() =>
      failingSubmit.component.submit({ kind: "text", text: "wake up" }, "spawn"),
    ).toThrow("queue full");

    const nonRemovingCancel = createSchedulerStub({ cancelResult: false });
    const task = await nonRemovingCancel.component.submit(
      { kind: "text", text: "wake up" },
      "spawn",
    );
    expect(await nonRemovingCancel.component.cancel(task)).toBe(false);
    expect(nonRemovingCancel.isLive(task)).toBe(true);
  });
});

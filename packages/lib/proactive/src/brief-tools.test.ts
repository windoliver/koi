import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, ScheduleId, SchedulerComponent } from "@koi/core";
import { scheduleId } from "@koi/core";
import {
  createBriefToolState,
  createCancelBriefTool,
  createCreateBriefTool,
  createListBriefsTool,
  createUpdateBriefTool,
  formatBriefWakeMessage,
} from "./brief-tools.js";
import { createSchedulerStub } from "./test-helpers.js";

function stubAdapter(name: string): ChannelAdapter {
  return {
    name,
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: true,
      supportsA2ui: false,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
    onMessage: () => () => {},
  };
}

const WAKE_LINES = [
  "Brief: weekly-status",
  "Topic: open PRs and CI failures",
  "Window: last 7 days",
  "Deliver to: slack",
  "Context: focus on regressions, not new features",
  "",
  "Synthesize a concise digest covering the topic over the window.",
  "Use the notify tool to deliver the digest to the channel above.",
];

describe("brief tools", () => {
  test("create_brief stores a brief and schedules a recurring wake", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);
    const listBriefs = createListBriefsTool(state);

    const created = (await createBrief.execute({
      name: "weekly-status",
      topic: "open PRs and CI failures",
      window: "last 7 days",
      channel: "slack",
      expression: "0 9 * * 1",
      timezone: "America/Los_Angeles",
      context_hint: "focus on regressions, not new features",
      idempotency_key: "weekly",
    })) as { ok: boolean; brief_id: string; schedule_id: string; deduped?: boolean };

    expect(created.ok).toBe(true);
    expect(created.deduped).toBeUndefined();
    expect(stub.scheduleCalls).toHaveLength(1);
    expect(stub.scheduleCalls[0]?.expression).toBe("0 9 * * 1");
    expect(stub.scheduleCalls[0]?.mode).toBe("dispatch");
    expect(stub.scheduleCalls[0]?.input).toEqual({
      kind: "text",
      text: WAKE_LINES.join("\n"),
    });
    expect(stub.scheduleCalls[0]?.options).toEqual({ timezone: "America/Los_Angeles" });

    const listed = (await listBriefs.execute({})) as {
      ok: boolean;
      briefs: ReadonlyArray<{
        brief_id: string;
        schedule_id: string;
        name: string;
        topic: string;
        window: string;
        channel: string;
        expression: string;
        timezone?: string;
        context_hint?: string;
      }>;
    };
    expect(listed.briefs).toHaveLength(1);
    expect(listed.briefs[0]).toEqual({
      brief_id: created.brief_id,
      schedule_id: created.schedule_id,
      name: "weekly-status",
      topic: "open PRs and CI failures",
      window: "last 7 days",
      channel: "slack",
      expression: "0 9 * * 1",
      timezone: "America/Los_Angeles",
      context_hint: "focus on regressions, not new features",
    });
  });

  test("create_brief dedupes same-process identical idempotency_key", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);

    const args = {
      name: "weekly",
      topic: "topic",
      window: "7d",
      channel: "slack",
      expression: "0 9 * * 1",
      idempotency_key: "k1",
    };
    const first = (await createBrief.execute(args)) as { brief_id: string; schedule_id: string };
    const second = (await createBrief.execute(args)) as {
      brief_id: string;
      schedule_id: string;
      deduped: boolean;
    };

    expect(second.brief_id).toBe(first.brief_id);
    expect(second.schedule_id).toBe(first.schedule_id);
    expect(second.deduped).toBe(true);
    expect(stub.scheduleCalls).toHaveLength(1);
  });

  test("create_brief rejects reused idempotency_key when fields differ", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);

    await createBrief.execute({
      name: "weekly",
      topic: "topic",
      window: "7d",
      channel: "slack",
      expression: "0 9 * * 1",
      idempotency_key: "k1",
    });
    const second = (await createBrief.execute({
      name: "weekly",
      topic: "DIFFERENT TOPIC",
      window: "7d",
      channel: "slack",
      expression: "0 9 * * 1",
      idempotency_key: "k1",
    })) as { ok: boolean; error: string };

    expect(second.ok).toBe(false);
    expect(second.error).toContain("k1");
    expect(second.error).toContain("differ");
    expect(stub.scheduleCalls).toHaveLength(1);
  });

  test("create_brief validates required fields before touching the scheduler", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);

    const result = (await createBrief.execute({
      name: "x",
      topic: "y",
      window: "z",
      expression: "0 9 * * 1",
    })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.scheduleCalls).toHaveLength(0);
  });

  test("create_brief clears reservation after a failed scheduler create", async () => {
    const stub = createSchedulerStub({ scheduleError: new Error("boom") });
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);

    const first = (await createBrief.execute({
      name: "weekly",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
      idempotency_key: "k1",
    })) as { ok: boolean; error: string };
    expect(first.ok).toBe(false);
    expect(state.createEntryByIdempotencyKey.size).toBe(0);

    const retryStub = createSchedulerStub();
    const retryCreate = createCreateBriefTool({ scheduler: retryStub.component }, state);
    const retry = (await retryCreate.execute({
      name: "weekly",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
      idempotency_key: "k1",
    })) as { ok: boolean; deduped?: boolean };
    expect(retry.ok).toBe(true);
    expect(retry.deduped).toBeUndefined();
  });

  test("list_briefs returns summary fields including channel and topic", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);
    const listBriefs = createListBriefsTool(state);

    await createBrief.execute({
      name: "a",
      topic: "t-a",
      window: "w-a",
      channel: "slack",
      expression: "0 9 * * 1",
    });
    await createBrief.execute({
      name: "b",
      topic: "t-b",
      window: "w-b",
      channel: "email",
      expression: "0 9 * * 5",
    });

    const listed = (await listBriefs.execute({})) as {
      briefs: ReadonlyArray<{ name: string; channel: string; topic: string }>;
    };
    expect(listed.briefs).toHaveLength(2);
    expect(listed.briefs.map((b) => b.name)).toEqual(["a", "b"]);
    expect(listed.briefs.map((b) => b.channel)).toEqual(["slack", "email"]);
    expect(listed.briefs.map((b) => b.topic)).toEqual(["t-a", "t-b"]);
  });

  test("update_brief rotates the backing schedule and replaces stored fields", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);
    const updateBrief = createUpdateBriefTool({ scheduler: stub.component }, state);
    const listBriefs = createListBriefsTool(state);

    const created = (await createBrief.execute({
      name: "weekly",
      topic: "old",
      window: "7d",
      channel: "slack",
      expression: "0 9 * * 1",
    })) as { brief_id: string; schedule_id: string };

    const updated = (await updateBrief.execute({
      brief_id: created.brief_id,
      topic: "new topic",
      expression: "0 9 * * 5",
    })) as { ok: boolean; brief_id: string; schedule_id: string };

    expect(updated.ok).toBe(true);
    expect(updated.brief_id).toBe(created.brief_id);
    expect(updated.schedule_id).not.toBe(created.schedule_id);
    expect(stub.unscheduleCalls).toEqual([scheduleId(created.schedule_id)]);

    const listed = (await listBriefs.execute({})) as {
      briefs: ReadonlyArray<{ topic: string; expression: string; schedule_id: string }>;
    };
    expect(listed.briefs[0]?.topic).toBe("new topic");
    expect(listed.briefs[0]?.expression).toBe("0 9 * * 5");
    expect(listed.briefs[0]?.schedule_id).toBe(updated.schedule_id);
  });

  test("update_brief fails for an unknown brief_id", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const updateBrief = createUpdateBriefTool({ scheduler: stub.component }, state);

    const result = (await updateBrief.execute({
      brief_id: "brief-missing",
      topic: "new",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("brief-missing");
  });

  test("update_brief preserves omitted fields by patch semantics", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);
    const updateBrief = createUpdateBriefTool({ scheduler: stub.component }, state);
    const listBriefs = createListBriefsTool(state);

    const created = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
      timezone: "UTC",
      context_hint: "h",
    })) as { brief_id: string };

    await updateBrief.execute({ brief_id: created.brief_id, topic: "t-new" });

    const listed = (await listBriefs.execute({})) as {
      briefs: ReadonlyArray<{
        brief_id: string;
        schedule_id: string;
        name: string;
        topic: string;
        window: string;
        channel: string;
        expression: string;
        timezone?: string;
        context_hint?: string;
      }>;
    };
    expect(listed.briefs[0]?.name).toBe("n");
    expect(listed.briefs[0]?.topic).toBe("t-new");
    expect(listed.briefs[0]?.window).toBe("w");
    expect(listed.briefs[0]?.channel).toBe("slack");
    expect(listed.briefs[0]?.expression).toBe("0 9 * * 1");
    expect(listed.briefs[0]?.timezone).toBe("UTC");
    expect(listed.briefs[0]?.context_hint).toBe("h");
  });

  test("update_brief leaves the original record intact when replacement schedule fails", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);
    const created = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
    })) as { brief_id: string; schedule_id: string };

    const failStub = createSchedulerStub({ scheduleError: new Error("schedule failed") });
    const updateBrief = createUpdateBriefTool({ scheduler: failStub.component }, state);
    const result = (await updateBrief.execute({
      brief_id: created.brief_id,
      topic: "new",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(state.briefsById.get(created.brief_id)?.topic).toBe("t");
    expect(state.briefsById.get(created.brief_id)?.scheduleId).toBe(created.schedule_id);
  });

  test("update_brief compensates when retiring the original schedule reports false", async () => {
    const stubCreate = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stubCreate.component }, state);
    const created = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
    })) as { brief_id: string; schedule_id: string };

    const updateStub = createSchedulerStub({ unscheduleResult: false });
    const updateBrief = createUpdateBriefTool({ scheduler: updateStub.component }, state);
    const result = (await updateBrief.execute({
      brief_id: created.brief_id,
      expression: "0 9 * * 5",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("retire");
    expect(state.briefsById.get(created.brief_id)?.scheduleId).toBe(created.schedule_id);
    expect(updateStub.scheduleCalls).toHaveLength(1);
    expect(updateStub.unscheduleCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("update_brief compensates when retiring the original schedule throws", async () => {
    const stubCreate = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stubCreate.component }, state);
    const created = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
    })) as { brief_id: string; schedule_id: string };

    let unscheduleCount = 0;
    const throwingComponent: SchedulerComponent = {
      submit: stubCreate.component.submit,
      cancel: stubCreate.component.cancel,
      schedule: async () => scheduleId("sched-replacement"),
      unschedule: async (_id: ScheduleId): Promise<boolean> => {
        unscheduleCount += 1;
        if (unscheduleCount === 1) throw new Error("retire failed");
        return true;
      },
      pause: stubCreate.component.pause,
      resume: stubCreate.component.resume,
      query: stubCreate.component.query,
      stats: stubCreate.component.stats,
      history: stubCreate.component.history,
    };
    const updateBrief = createUpdateBriefTool({ scheduler: throwingComponent }, state);
    const result = (await updateBrief.execute({
      brief_id: created.brief_id,
      expression: "0 9 * * 5",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("retire failed");
    expect(state.briefsById.get(created.brief_id)?.scheduleId).toBe(created.schedule_id);
    expect(unscheduleCount).toBe(2);
  });

  test("cancel_brief removes the record and clears create-time idempotency", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);
    const cancelBrief = createCancelBriefTool({ scheduler: stub.component }, state);
    const listBriefs = createListBriefsTool(state);

    const created = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
      idempotency_key: "weekly",
    })) as { brief_id: string; schedule_id: string };

    const cancelled = (await cancelBrief.execute({
      brief_id: created.brief_id,
    })) as { ok: boolean; removed: boolean };
    expect(cancelled).toEqual({ ok: true, removed: true });
    expect(stub.unscheduleCalls).toEqual([scheduleId(created.schedule_id)]);

    const listed = (await listBriefs.execute({})) as { briefs: unknown[] };
    expect(listed.briefs).toHaveLength(0);

    const recreated = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
      idempotency_key: "weekly",
    })) as { brief_id: string };
    expect(recreated.brief_id).not.toBe(created.brief_id);
  });

  test("cancel_brief twice is idempotent — second call removes nothing and does not re-unschedule", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const createBrief = createCreateBriefTool({ scheduler: stub.component }, state);
    const cancelBrief = createCancelBriefTool({ scheduler: stub.component }, state);

    const created = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
    })) as { brief_id: string; schedule_id: string };

    const first = await cancelBrief.execute({ brief_id: created.brief_id });
    expect(first).toEqual({ ok: true, removed: true });
    expect(stub.unscheduleCalls).toEqual([scheduleId(created.schedule_id)]);

    const second = await cancelBrief.execute({ brief_id: created.brief_id });
    expect(second).toEqual({ ok: true, removed: false });
    expect(stub.unscheduleCalls).toEqual([scheduleId(created.schedule_id)]);
  });

  test("cancel_brief returns removed:false for an unknown brief_id", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const cancelBrief = createCancelBriefTool({ scheduler: stub.component }, state);

    const result = await cancelBrief.execute({ brief_id: "brief-missing" });
    expect(result).toEqual({ ok: true, removed: false });
  });

  test("formatBriefWakeMessage renders deterministic multi-line text with all fields", () => {
    expect(
      formatBriefWakeMessage({
        name: "weekly-status",
        topic: "open PRs and CI failures",
        window: "last 7 days",
        channel: "slack",
        contextHint: "focus on regressions, not new features",
      }),
    ).toBe(WAKE_LINES.join("\n"));
  });

  test("formatBriefWakeMessage omits the Context line when no context hint is set", () => {
    expect(
      formatBriefWakeMessage({
        name: "weekly-status",
        topic: "open PRs and CI failures",
        window: "last 7 days",
        channel: "slack",
      }),
    ).toBe(
      [
        "Brief: weekly-status",
        "Topic: open PRs and CI failures",
        "Window: last 7 days",
        "Deliver to: slack",
        "",
        "Synthesize a concise digest covering the topic over the window.",
        "Use the notify tool to deliver the digest to the channel above.",
      ].join("\n"),
    );
  });

  test("create_brief rejects unknown channel pre-schedule when resolveChannel is configured", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const slack = stubAdapter("slack");
    const createBrief = createCreateBriefTool(
      {
        scheduler: stub.component,
        resolveChannel: (n) => (n === "slack" ? slack : undefined),
        channelNames: () => ["slack"],
      },
      state,
    );

    const result = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "telegram",
      expression: "0 9 * * 1",
    })) as { ok: boolean; error: string; available_channels: readonly string[] };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown channel");
    expect(result.available_channels).toEqual(["slack"]);
    expect(stub.scheduleCalls).toHaveLength(0);
  });

  test("update_brief rejects unknown channel when resolveChannel is configured", async () => {
    const stub = createSchedulerStub();
    const state = createBriefToolState();
    const slack = stubAdapter("slack");
    const config = {
      scheduler: stub.component,
      resolveChannel: (n: string) => (n === "slack" ? slack : undefined),
      channelNames: () => ["slack"],
    };
    const createBrief = createCreateBriefTool(config, state);
    const updateBrief = createUpdateBriefTool(config, state);

    const created = (await createBrief.execute({
      name: "n",
      topic: "t",
      window: "w",
      channel: "slack",
      expression: "0 9 * * 1",
    })) as { brief_id: string; schedule_id: string };

    const before = state.briefsById.get(created.brief_id);
    const result = (await updateBrief.execute({
      brief_id: created.brief_id,
      channel: "telegram",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown channel");
    expect(state.briefsById.get(created.brief_id)).toEqual(before!);
  });
});

import { describe, expect, mock, test } from "bun:test";
import type { AgentId, EngineInput } from "@koi/core";
import {
  createTemporalScheduler,
  type TemporalClientLike,
  type TemporalSchedulerConfig,
} from "./temporal-scheduler.js";

function makeMockClient(wfOverrides?: Partial<TemporalClientLike["workflow"]>): TemporalClientLike {
  return {
    workflow: {
      start: mock(async () => ({ workflowId: "wf-1" })),
      signal: mock(async () => undefined),
      cancel: mock(async () => undefined),
      // Required: completion tracking. Default never resolves (task stays running) unless overridden.
      getResult: mock(async () => new Promise<unknown>(() => {})),
      ...wfOverrides,
    },
    schedule: {
      create: mock(async () => undefined),
      delete: mock(async () => undefined),
      pause: mock(async () => undefined),
      unpause: mock(async () => undefined),
    },
  };
}

function makeConfig(client: TemporalClientLike): TemporalSchedulerConfig {
  return { client, taskQueue: "test-queue", workflowType: "agentWorkflow" };
}

const AGENT_ID = "agent-1" as AgentId;
const TEXT_INPUT = { kind: "text", text: "hello" } as unknown as EngineInput;
const MESSAGES_INPUT = {
  kind: "messages",
  messages: [
    {
      content: [
        { kind: "text", text: "from message" },
        { kind: "image", url: "https://example.com/img.png", alt: "test" },
      ],
      senderId: "u1",
      timestamp: 1,
    },
  ],
} as unknown as EngineInput;
const PINNED_MESSAGES_INPUT = {
  kind: "messages",
  messages: [
    { content: [{ kind: "text", text: "pinned" }], senderId: "u1", timestamp: 1, pinned: true },
  ],
} as unknown as EngineInput;
const RESUME_INPUT = { kind: "resume", state: {} } as unknown as EngineInput;

describe("submit", () => {
  test("returns a TaskId", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(typeof id).toBe("string");
    expect(id).toContain("task:");
  });

  test("starts a Temporal workflow", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(client.workflow.start).toHaveBeenCalledTimes(1);
  });

  test("signals the workflow with message", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    expect(client.workflow.signal).toHaveBeenCalledTimes(1);
  });

  test("emits task:submitted event", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    const events: unknown[] = [];
    scheduler.watch((e) => events.push(e));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect((events[0] as { kind: string }).kind).toBe("task:submitted");
  });

  test("defaults priority to 5", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    const tasks = await scheduler.query({});
    expect(tasks[0]?.priority).toBe(5);
  });

  test("applies priority from options", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", { priority: 1 });
    const tasks = await scheduler.query({ agentId: AGENT_ID });
    expect(tasks[0]?.priority).toBe(1);
  });

  test("converts text EngineInput to content array in signal", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    const payload = signalArgs?.[2] as { content: readonly unknown[] };
    expect(payload.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("preserves all ContentBlock types from messages EngineInput", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, MESSAGES_INPUT, "spawn");
    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    const payload = signalArgs?.[2] as { content: readonly unknown[] };
    expect(payload.content).toEqual([
      { kind: "text", text: "from message" },
      { kind: "image", url: "https://example.com/img.png", alt: "test" },
    ]);
  });

  test("converts resume EngineInput to empty content with resumeState", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, RESUME_INPUT, "spawn");
    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    const payload = signalArgs?.[2] as { content: readonly unknown[]; resumeState: unknown };
    expect(payload.content).toEqual([]);
    expect(payload.resumeState).toEqual({});
  });

  test("preserves pinned flag from messages input", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, PINNED_MESSAGES_INPUT, "spawn");
    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    const payload = signalArgs?.[2] as { pinned: boolean | undefined };
    expect(payload.pinned).toBe(true);
  });

  test("throws when timeoutMs is passed to submit — not enforced", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", { timeoutMs: 5000 }),
    ).rejects.toThrow("does not enforce timeoutMs");
  });

  test("throws when maxRetries is passed to submit — not enforced", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", { maxRetries: 3 }),
    ).rejects.toThrow("does not enforce");
  });

  test("throws when delayMs is used with dispatch mode", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", { delayMs: 1000 }),
    ).rejects.toThrow("delayMs is not supported for dispatch mode");
  });

  test("passes startDelay when delayMs is set", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", { delayMs: 5000 });
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const opts = startArgs?.[1] as Record<string, unknown>;
    expect(opts.startDelay).toBe("5000ms");
  });

  test("transitions task to running after signal", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("running");
  });

  test("tracks workflow completion via getResult", async () => {
    let resolveResult!: (value: unknown) => void;
    const resultPromise = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const client = makeMockClient({ getResult: mock(async () => resultPromise) });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    resolveResult({ done: true });
    await new Promise((r) => setTimeout(r, 10));
    expect((await scheduler.query({}))[0]?.status).toBe("completed");
    expect((await scheduler.history({}))[0]?.status).toBe("completed");
  });

  test("tracks workflow failure via getResult", async () => {
    let rejectResult!: (error: unknown) => void;
    const resultPromise = new Promise<unknown>((_, reject) => {
      rejectResult = reject;
    });
    const client = makeMockClient({ getResult: mock(async () => resultPromise) });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    rejectResult(new Error("workflow failed"));
    await new Promise((r) => setTimeout(r, 10));
    expect((await scheduler.query({}))[0]?.status).toBe("failed");
    expect((await scheduler.history({}))[0]?.error).toBe("workflow failed");
  });
});

describe("dispatch mode", () => {
  test("dispatch does NOT start a new workflow", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    expect(client.workflow.start).not.toHaveBeenCalled();
  });

  test("dispatch signals the existing agent workflow by agentId", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    expect(signalArgs?.[0]).toBe(String(AGENT_ID));
  });

  test("spawn starts a new workflow with a unique id", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(client.workflow.start).toHaveBeenCalledTimes(1);
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const opts = startArgs?.[1] as Record<string, unknown>;
    expect(typeof opts.workflowId).toBe("string");
    expect(opts.workflowId).not.toBe(String(AGENT_ID));
  });

  test("dispatch schedule uses sendSignal action not startWorkflow", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "dispatch");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as {
      action: { type: string; signalName: string; workflowId: string };
    };
    expect(opts.action.type).toBe("sendSignal");
    expect(opts.action.signalName).toBe("scheduled-input");
    expect(opts.action.workflowId).toBe(String(AGENT_ID));
  });

  test("spawn schedule uses startWorkflow action", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { action: { type: string } };
    expect(opts.action.type).toBe("startWorkflow");
  });
});

describe("rollback safety", () => {
  test("workflow.start failure: rejects and records task as failed for observability", async () => {
    const client = makeMockClient({
      start: mock(async () => {
        throw new Error("connection refused");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(
      "connection refused",
    );
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("failed");
    const records = await scheduler.history({});
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.error).toContain("connection refused");
  });

  test("workflow.start failure: attempts to cancel the orphaned workflow", async () => {
    const client = makeMockClient({
      start: mock(async () => {
        throw new Error("start failed");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow();
    expect(client.workflow.cancel).toHaveBeenCalled();
  });

  test("workflow.signal failure after start: rejects and records failed task, cancel called", async () => {
    const client = makeMockClient({
      signal: mock(async () => {
        throw new Error("signal failed");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow("signal failed");
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("failed");
    expect(client.workflow.cancel).toHaveBeenCalled();
  });

  test("start+signal success: task emitted as submitted before running", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const events: string[] = [];
    scheduler.watch((e) => events.push(e.kind));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(events).toContain("task:submitted");
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("running");
  });
});

describe("cancel", () => {
  test("cancels an existing task", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(await scheduler.cancel(id)).toBe(true);
    expect(client.workflow.cancel).toHaveBeenCalled();
  });

  test("dispatch cancel returns false — signal already consumed, cancelling would destroy the agent", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    expect(await scheduler.cancel(id)).toBe(false);
    expect(client.workflow.cancel).not.toHaveBeenCalled();
  });

  test("returns false for unknown task", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    expect(await scheduler.cancel("nonexistent" as never)).toBe(false);
  });

  test("cancel prevents getResult from overwriting cancelled status", async () => {
    let resolveResult!: (value: unknown) => void;
    const resultPromise = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const client = makeMockClient({ getResult: mock(async () => resultPromise) });
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.cancel(id);
    // Resolve getResult after cancel — should be a no-op
    resolveResult({ done: true });
    await new Promise((r) => setTimeout(r, 10));
    // task should stay "failed" (cancelled), not flip to "completed"
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("failed");
  });

  test("emits task:cancelled event", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    const events: unknown[] = [];
    scheduler.watch((e) => events.push(e));
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.cancel(id);
    expect(events.some((e) => (e as { kind: string }).kind === "task:cancelled")).toBe(true);
  });
});

describe("schedule / unschedule", () => {
  test("creates a Temporal schedule with raw EngineInput template (not baked messages)", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    expect(id).toContain("sched:");
    expect(client.schedule.create).toHaveBeenCalledTimes(1);
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { action: { args: readonly [Record<string, unknown>] } };
    const wfConfig = opts.action.args[0];
    // Raw EngineInput is embedded so each firing generates fresh IDs/timestamps
    expect(wfConfig).toHaveProperty("input");
    expect(wfConfig).not.toHaveProperty("initialMessages");
  });

  test("passes timezone in schedule spec", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn", {
      timezone: "America/New_York",
    });
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { spec: { timezone?: string } };
    expect(opts.spec.timezone).toBe("America/New_York");
  });

  test("omits timezone when not provided", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { spec: Record<string, unknown> };
    expect(opts.spec).not.toHaveProperty("timezone");
  });

  test("emits schedule:created event", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    const events: unknown[] = [];
    scheduler.watch((e) => events.push(e));
    await scheduler.schedule("*/5 * * * *", AGENT_ID, TEXT_INPUT, "dispatch");
    expect(events.some((e) => (e as { kind: string }).kind === "schedule:created")).toBe(true);
  });

  test("unschedule removes the schedule", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    expect(await scheduler.unschedule(id)).toBe(true);
    expect(client.schedule.delete).toHaveBeenCalledTimes(1);
  });

  test("unschedule returns false for unknown schedule", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    expect(await scheduler.unschedule("nonexistent" as never)).toBe(false);
  });

  test("schedule creation failure leaves no phantom local schedule", async () => {
    const client = {
      ...makeMockClient(),
      schedule: {
        create: mock(async () => {
          throw new Error("create failed");
        }),
        delete: mock(async () => undefined),
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
      },
    };
    const scheduler = createTemporalScheduler(makeConfig(client));
    let threw = false;
    try {
      await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const s = await scheduler.stats();
    expect(s.activeSchedules).toBe(0);
  });

  test("dispatch schedule uses scheduled-input signal with raw EngineInput (no baked message IDs)", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "dispatch");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as {
      action: { type: string; signalName: string; args: readonly unknown[] };
    };
    expect(opts.action.type).toBe("sendSignal");
    expect(opts.action.signalName).toBe("scheduled-input");
    // Raw EngineInput template passed so each firing materializes fresh message IDs/timestamps
    expect(opts.action.args[0]).toEqual(TEXT_INPUT);
  });

  test("dispatch schedule with multi-message input passes raw input without materialization", async () => {
    const twoMessages = {
      kind: "messages",
      messages: [
        { content: [{ kind: "text", text: "msg1" }], senderId: "u1", timestamp: 1 },
        { content: [{ kind: "text", text: "msg2" }], senderId: "u2", timestamp: 2 },
      ],
    } as unknown as EngineInput;
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    // No throw — raw EngineInput is passed through; workflow handles fan-out
    await scheduler.schedule("0 0 * * *", AGENT_ID, twoMessages, "dispatch");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { action: { args: readonly unknown[] } };
    expect(opts.action.args[0]).toEqual(twoMessages);
  });

  test("schedule() rejects timeoutMs to prevent false guarantee of enforcement", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn", { timeoutMs: 5000 }),
    ).rejects.toThrow("does not enforce timeoutMs");
  });

  test("schedule() rejects maxRetries to prevent false guarantee of enforcement", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn", { maxRetries: 3 }),
    ).rejects.toThrow("does not enforce");
  });

  test("schedule() rejects delayMs — cron schedules fire on the tick, not with a delay", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn", { delayMs: 1000 }),
    ).rejects.toThrow("does not enforce");
  });

  test("spawn schedule includes explicit workflowId for deterministic Temporal overlap policies", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { action: { type: string; workflowId: string } };
    expect(opts.action.type).toBe("startWorkflow");
    expect(typeof opts.action.workflowId).toBe("string");
    expect(opts.action.workflowId).toContain("sched:");
  });

  test("spawn schedule strips non-serializable EngineInput fields", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const inputWithHandlers = {
      kind: "text",
      text: "hello",
      callHandlers: { modelCall: () => Promise.resolve({}) },
      signal: new AbortController().signal,
    } as unknown as EngineInput;
    await scheduler.schedule("0 0 * * *", AGENT_ID, inputWithHandlers, "spawn");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { action: { args: readonly [Record<string, unknown>] } };
    const spawnArgs = opts.action.args[0];
    const payload = spawnArgs?.input as Record<string, unknown>;
    expect(payload).not.toHaveProperty("callHandlers");
    expect(payload).not.toHaveProperty("signal");
    expect(payload).toEqual({ kind: "text", text: "hello" });
  });

  test("schedule() rejects non-plain objects (Date, Map, Set, class instances)", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    const badInput = {
      kind: "messages",
      messages: [
        { content: [{ kind: "text", text: "ok", ts: new Date() }], senderId: "u1", timestamp: 1 },
      ],
    } as unknown as EngineInput;
    await expect(scheduler.schedule("0 0 * * *", AGENT_ID, badInput, "spawn")).rejects.toThrow(
      "non-plain object",
    );
  });

  test("schedule() rejects payload with non-JSON-serializable content (circular reference)", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular; // circular ref causes JSON.stringify to throw
    const badInput = {
      kind: "messages",
      messages: [
        { content: [{ kind: "text", text: "ok", extra: circular }], senderId: "u1", timestamp: 1 },
      ],
    } as unknown as EngineInput;
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(scheduler.schedule("0 0 * * *", AGENT_ID, badInput, "spawn")).rejects.toThrow(
      "non-JSON-serializable",
    );
  });

  test("spawn schedule omits sessionId so each run uses its own execution id", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as { action: { args: readonly [Record<string, unknown>] } };
    const wfConfig = opts.action.args[0];
    expect(wfConfig).not.toHaveProperty("sessionId");
  });
});

describe("pause / resume", () => {
  test("pause pauses a schedule", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    expect(await scheduler.pause(id)).toBe(true);
    expect(client.schedule.pause).toHaveBeenCalledTimes(1);
  });

  test("resume resumes a paused schedule", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.pause(id);
    expect(await scheduler.resume(id)).toBe(true);
    expect(client.schedule.unpause).toHaveBeenCalledTimes(1);
  });

  test("pause returns false for unknown schedule", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    expect(await scheduler.pause("nonexistent" as never)).toBe(false);
  });
});

describe("query / stats / history", () => {
  test("query returns all tasks", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    expect((await scheduler.query({})).length).toBe(2);
  });

  test("dispatch task reaches completed immediately after signal delivery", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("completed");
    const records = await scheduler.history({});
    expect(records[0]?.status).toBe("completed");
  });

  test("query respects limit", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect((await scheduler.query({ limit: 2 })).length).toBe(2);
  });

  test("stats reflects running task and active schedule", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const s = await scheduler.stats();
    expect(s.running).toBe(1);
    expect(s.activeSchedules).toBe(1);
  });

  test("history returns empty for fresh scheduler", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    expect((await scheduler.history({})).length).toBe(0);
  });
});

describe("watch", () => {
  test("unsubscribe stops event delivery", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    const events: unknown[] = [];
    const unsub = scheduler.watch((e) => events.push(e));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(events).toHaveLength(1);
    unsub();
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(events).toHaveLength(1);
  });
});

describe("dispose", () => {
  test("clears all state on dispose", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler[Symbol.asyncDispose]();
    expect((await scheduler.query({})).length).toBe(0);
    expect((await scheduler.stats()).pending).toBe(0);
  });
});

describe("state persistence (dbPath)", () => {
  test("restores tasks from disk so query/history survive restart", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const client = makeMockClient();

    // First scheduler: submit a task then dispose.
    const s1 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await s1.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await s1[Symbol.asyncDispose]();

    // Second scheduler with same dbPath: should restore the task.
    const s2 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const tasks = await s2.query({});
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.agentId).toBe(AGENT_ID);
    expect(tasks[0]?.status).toBe("running");
    await s2[Symbol.asyncDispose]();
  });

  test("restores schedules from disk across restart", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const client = makeMockClient();

    const s1 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await s1.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    await s1[Symbol.asyncDispose]();

    const s2 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const stats = await s2.stats();
    expect(stats.activeSchedules).toBe(1);
    await s2[Symbol.asyncDispose]();
  });

  test("reattaches getResult for running spawn tasks after restart", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    let resolveResult!: (value: unknown) => void;
    const resultPromise = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const client = makeMockClient({ getResult: mock(async () => resultPromise) });

    // First scheduler: submit and persist running state.
    const s1 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await s1.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await s1[Symbol.asyncDispose]();

    // Second scheduler restores state and reattaches getResult tracking.
    const s2 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    expect((await s2.query({}))[0]?.status).toBe("running");

    // Workflow completes — second scheduler should record completion.
    resolveResult({ done: true });
    await new Promise((r) => setTimeout(r, 20));
    expect((await s2.query({}))[0]?.status).toBe("completed");
    await s2[Symbol.asyncDispose]();
  });

  test("works without dbPath (no persistence, no error)", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    const tasks = await scheduler.query({});
    expect(tasks.length).toBe(1);
    await scheduler[Symbol.asyncDispose]();
  });

  test("corrupt dbPath throws on creation", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(dbPath, "not-valid-json{{{{");
    expect(() => createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath })).toThrow(
      /cannot be loaded/,
    );
  });
});

describe("asyncDispose — disposed guard", () => {
  test("getResult callback is no-op after dispose", async () => {
    let resolveResult!: (value: unknown) => void;
    const resultPromise = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const client = makeMockClient({ getResult: mock(async () => resultPromise) });
    const events: string[] = [];

    const scheduler = createTemporalScheduler(makeConfig(client));
    scheduler.watch((e) => events.push(e.kind));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    // Dispose clears listeners and sets the disposed flag.
    await scheduler[Symbol.asyncDispose]();

    // Resolve the workflow result after dispose — the callback must be a no-op.
    resolveResult({ done: true });
    await new Promise((r) => setTimeout(r, 20));

    // "task:completed" must NOT have been emitted post-dispose (listeners were cleared,
    // and the disposed guard prevents any further emit/persist calls).
    expect(events.filter((k) => k === "task:completed")).toHaveLength(0);
  });
});

describe("schedule — overlap and reuse policy", () => {
  test("spawn schedule passes workflowIdReusePolicy and overlapPolicy to client", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn");

    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as Record<string, unknown>;
    const action = opts?.action as Record<string, unknown> | undefined;
    const policies = opts?.policies as Record<string, unknown> | undefined;

    expect(action?.workflowIdReusePolicy).toBe("ALLOW_DUPLICATE");
    expect(policies?.overlapPolicy).toBe("SKIP");

    await scheduler[Symbol.asyncDispose]();
  });

  test("dispatch schedule does not set workflowIdReusePolicy", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "dispatch");

    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const opts = createArgs?.[1] as Record<string, unknown>;
    const action = opts?.action as Record<string, unknown> | undefined;
    const policies = opts?.policies as Record<string, unknown> | undefined;

    expect(action?.workflowIdReusePolicy).toBeUndefined();
    expect(policies?.overlapPolicy).toBe("SKIP");

    await scheduler[Symbol.asyncDispose]();
  });
});

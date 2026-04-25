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
      // Default: schedule does not exist (not-found) — pending IDs are cleared on startup.
      getHandle: mock(() => ({
        describe: mock(async () => {
          throw new Error("schedule not found");
        }),
      })),
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
    // Spawn: messages are passed atomically in workflow start args (not signals)
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const spawnConfig = (startArgs?.[1] as Record<string, unknown>).args as readonly unknown[];
    const wfArgs = spawnConfig?.[0] as Record<string, unknown>;
    const msgs = wfArgs?.initialMessages as readonly Record<string, unknown>[];
    expect(msgs?.[0]?.content).toEqual([{ kind: "text", text: "hello" }]);
    // No separate signal sent for spawn mode
    expect(client.workflow.signal).not.toHaveBeenCalled();
  });

  test("preserves all ContentBlock types from messages EngineInput", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, MESSAGES_INPUT, "spawn");
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const spawnConfig = (startArgs?.[1] as Record<string, unknown>).args as readonly unknown[];
    const wfArgs = spawnConfig?.[0] as Record<string, unknown>;
    const msgs = wfArgs?.initialMessages as readonly Record<string, unknown>[];
    expect(msgs?.[0]?.content).toEqual([
      { kind: "text", text: "from message" },
      { kind: "image", url: "https://example.com/img.png", alt: "test" },
    ]);
  });

  test("converts resume EngineInput to empty content with resumeState", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, RESUME_INPUT, "spawn");
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const spawnConfig = (startArgs?.[1] as Record<string, unknown>).args as readonly unknown[];
    const wfArgs = spawnConfig?.[0] as Record<string, unknown>;
    const msgs = wfArgs?.initialMessages as readonly Record<string, unknown>[];
    expect(msgs?.[0]?.content).toEqual([]);
    expect(msgs?.[0]?.resumeState).toEqual({});
  });

  test("preserves pinned flag from messages input", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, PINNED_MESSAGES_INPUT, "spawn");
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const spawnConfig = (startArgs?.[1] as Record<string, unknown>).args as readonly unknown[];
    const wfArgs = spawnConfig?.[0] as Record<string, unknown>;
    const msgs = wfArgs?.initialMessages as readonly Record<string, unknown>[];
    expect(msgs?.[0]?.pinned).toBe(true);
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

  test("dispatch signal failure — transport error (ECONNRESET) marks completed and does not throw", async () => {
    // When workflow.signal() throws a transport-level error (connection reset, timeout, UNAVAILABLE),
    // the signal MAY have been delivered — the client lost the ACK, not the signal. Rethrowing
    // would let callers retry with a NEW task ID, duplicating the signal in the live workflow.
    // Instead: treat delivery as optimistically successful, return the task ID, record completed.
    const client = makeMockClient({
      signal: mock(async () => {
        throw new Error("ECONNRESET: connection reset by peer");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    expect(typeof id).toBe("string");
    const tasks = await scheduler.query({});
    // Treated as completed (optimistic delivery) — not failed
    expect(tasks[0]?.status).toBe("completed");
    // dispatch has no new workflow to cancel
    expect(client.workflow.cancel).not.toHaveBeenCalled();
  });

  test("dispatch signal failure — definite rejection (workflow not found) marks failed and throws", async () => {
    // When signal throws "not found", the signal was provably not enqueued — safe to fail+throw
    // without risk of duplicate delivery (the workflow does not exist).
    const client = makeMockClient({
      signal: mock(async () => {
        throw new Error("workflow not found");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch")).rejects.toThrow(
      "workflow not found",
    );
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("failed");
    expect(client.workflow.cancel).not.toHaveBeenCalled();
  });

  test("dispatch signal failure — auth/permission error marks failed and throws (not ambiguous)", async () => {
    // Auth failures are definite rejections — the signal was never enqueued. Surface the error.
    const client = makeMockClient({
      signal: mock(async () => {
        throw new Error("permission denied: unauthorized");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch")).rejects.toThrow(
      "permission denied",
    );
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("failed");
  });

  test("dispatch sends whole message batch as single signal (atomic delivery)", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, MESSAGES_INPUT, "dispatch");
    const signalCalls = (client.workflow.signal as ReturnType<typeof mock>).mock.calls;
    // Only one signal call for the entire batch
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]?.[1]).toBe("messages");
    // The third arg is the messages array
    const batch = signalCalls[0]?.[2] as readonly unknown[];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(1);
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
        getHandle: mock(() => ({
          describe: mock(async () => {
            throw new Error("schedule not found");
          }),
        })),
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
    ).rejects.toThrow("does not support");
  });

  test("schedule() rejects maxRetries to prevent false guarantee of enforcement", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn", { maxRetries: 3 }),
    ).rejects.toThrow("does not support");
  });

  test("schedule() rejects delayMs — cron schedules fire on the tick, not with a delay", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn", { delayMs: 1000 }),
    ).rejects.toThrow("does not support");
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
  test("query returns only spawn tasks (dispatch tasks not tracked as live tasks)", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    // Dispatch tasks are removed from tasks map after signal delivery — we cannot know when
    // the target workflow completes, so we don't falsely report them as "completed".
    expect((await scheduler.query({})).length).toBe(1);
  });

  test("dispatch signal delivery records in history but does not appear in query", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    // Not visible to query() — no live task tracking for dispatch
    expect((await scheduler.query({})).length).toBe(0);
    // But history retains the audit trail of the signal delivery
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

  test("invalid task status in snapshot throws on creation", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [
          [
            "t1",
            {
              id: "t1",
              agentId: "a1",
              mode: "spawn",
              input: { kind: "text", text: "hi" },
              priority: 0,
              status: "cancelled",
              createdAt: 1,
              retries: 0,
              maxRetries: 3,
            },
          ],
        ],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
      }),
    );
    expect(() => createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath })).toThrow(
      /cannot be loaded|missing required fields|wrong types/,
    );
  });

  test("invalid history status in snapshot throws on creation", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [
          {
            taskId: "t1",
            agentId: "a1",
            status: "unknown-status",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            retryAttempt: 0,
          },
        ],
      }),
    );
    expect(() => createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath })).toThrow(
      /cannot be loaded|missing required fields|invalid status/,
    );
  });

  test("second scheduler with same dbPath throws — single-writer invariant", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const s1 = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    try {
      expect(() => createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath })).toThrow(
        /already held by PID/,
      );
    } finally {
      await s1[Symbol.asyncDispose]();
    }
  });

  test("lock is released on dispose so next scheduler can acquire it", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const s1 = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    await s1[Symbol.asyncDispose]();
    // Should not throw — lock was released.
    const s2 = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    await s2[Symbol.asyncDispose]();
  });

  test("stale lock file (dead PID) is overwritten on startup", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const { writeFileSync } = await import("node:fs");
    // Write a lock file with PID 999999999 and a foreign session token.
    writeFileSync(`${dbPath}.lock`, "999999999:foreign-session-token");
    // Should not throw — stale lock is overwritten.
    const s = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    await s[Symbol.asyncDispose]();
  });

  test("unparseable lock file (create/write window race) is treated as live — fail closed", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const { writeFileSync } = await import("node:fs");
    // Write an empty lock file — simulates the window between openSync() and writeSync()
    // where a competing reader sees the file before the owner has written the pid:token.
    writeFileSync(`${dbPath}.lock`, "");
    // Should throw because we cannot parse the lock file (fail closed).
    expect(() => createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath })).toThrow(
      /lock file exists but cannot be parsed/,
    );
  });

  test("lock file with live PID but different session token is treated as stale (PID reuse)", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const { writeFileSync } = await import("node:fs");
    // Write a lock file with this process's own PID but a foreign session token.
    // Simulates PID reuse: same PID, but a different process instance wrote the lock.
    writeFileSync(`${dbPath}.lock`, `${process.pid}:foreign-session-token-not-ours`);
    // Should not throw — same PID but different session token means stale.
    const s = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    await s[Symbol.asyncDispose]();
  });

  test("constructor failure releases lock so the same process can retry", async () => {
    const { existsSync, writeFileSync } = await import("node:fs");
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    // Write a corrupt snapshot so loadStateSync throws.
    writeFileSync(dbPath, "not-valid-json{{{{");
    expect(() => createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath })).toThrow(
      /cannot be loaded/,
    );
    // Lock file must have been removed — a retry without manual cleanup must succeed.
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  test("idempotent spawn failure — attaches getResult watcher instead of throwing or cancelling", async () => {
    // Simulate ACK-lost scenario: workflow.start() throws but the workflow may exist.
    // getResult is held pending so we can verify the task is in "running" state.
    let resolveGetResult!: (v: unknown) => void;
    const getResultPromise = new Promise<unknown>((res) => {
      resolveGetResult = res;
    });
    const client = makeMockClient({
      start: mock(async () => {
        throw new Error("Workflow execution already started");
      }),
      getResult: mock(async () => getResultPromise),
    });
    const events: string[] = [];
    const scheduler = createTemporalScheduler(makeConfig(client));
    scheduler.watch((e) => events.push(e.kind));

    // submit() must NOT throw — returns the stable task ID for lifecycle tracking.
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", {
      idempotencyKey: "idm-spawn",
    });
    expect(typeof id).toBe("string");

    // cancel must NOT be called — could kill a live workflow with the same stable ID.
    expect(client.workflow.cancel).not.toHaveBeenCalled();

    // Task must be "running" (watcher attached), not "failed".
    const [task] = await scheduler.query({});
    expect(task?.status).toBe("running");
    expect(events).toContain("task:submitted");

    // When the workflow resolves, the task should complete.
    resolveGetResult({ output: 42 });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toContain("task:completed");

    await scheduler[Symbol.asyncDispose]();
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

  test("rejects priority option in schedule", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn", { priority: 1 }),
    ).rejects.toThrow(/does not support/);
    await scheduler[Symbol.asyncDispose]();
  });

  test("rejects metadata option in schedule", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn", {
        metadata: { tag: "test" },
      }),
    ).rejects.toThrow(/does not support/);
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("persist durability — mutation APIs propagate write failures", () => {
  const VALID_INITIAL_STATE = JSON.stringify({
    tasks: [],
    taskWorkflowIds: [],
    cancelledTaskIds: [],
    schedules: [],
    history: [],
  });

  test("submit throws when persistence write fails", async () => {
    const { mkdirSync, writeFileSync, chmodSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(dbPath, VALID_INITIAL_STATE);
    // Create scheduler while dir is still writable so the advisory lock file can be written.
    // Then block writes — .tmp file creation will fail on subsequent mutations.
    const scheduler = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    chmodSync(dir, 0o555);
    await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(
      /durability write failed/,
    );
    chmodSync(dir, 0o755);
    rmdirSync(dir, { recursive: true });
    await scheduler[Symbol.asyncDispose]();
  });

  test("schedule throws when persistence write fails", async () => {
    const { mkdirSync, writeFileSync, chmodSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(dbPath, VALID_INITIAL_STATE);
    // Create scheduler while dir is still writable so the advisory lock file can be written.
    const scheduler = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    chmodSync(dir, 0o555);
    await expect(scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(
      /durability write failed/,
    );
    chmodSync(dir, 0o755);
    rmdirSync(dir, { recursive: true });
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("dispatch durability — post-signal persist failure emits task:failed event", () => {
  test("emits task:failed with signalDelivered context when post-dispatch persist fails", async () => {
    // Use a custom healthCheckFn-style approach: inject a dbPath but use a mock client that
    // allows us to trigger post-signal persist failure selectively via a signal mock that
    // removes the dbPath between signal and persist.
    // We simulate the failure by using a dbPath in a directory we delete after lock acquisition.
    const { mkdirSync, writeFileSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
      }),
    );
    // The signal mock removes the dir to cause post-signal persist to fail.
    const signalMock = mock(async () => {
      // Allow pre-commit persist to have already succeeded; now destroy the dir so the
      // post-signal persist write fails with ENOENT on the .tmp file.
      rmdirSync(dir, { recursive: true });
    });
    const client = makeMockClient({ signal: signalMock });
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const failedEvents: unknown[] = [];
    scheduler.watch((ev) => {
      if (ev.kind === "task:failed") failedEvents.push(ev);
    });
    // submit() dispatch: pre-commit succeeds, signal triggers dir removal, post-persist fails
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    expect(id).toBeDefined(); // submit returns normally (no throw — avoids duplicate signal)
    expect(failedEvents.length).toBe(1);
    const ev = failedEvents[0] as {
      kind: string;
      taskId: string;
      error: { context: { signalDelivered: boolean } };
    };
    expect(ev.kind).toBe("task:failed");
    expect(ev.taskId).toBe(id);
    expect(ev.error.context.signalDelivered).toBe(true);
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("unschedule / pause / resume — durability failures propagate", () => {
  const VALID_INITIAL_STATE = JSON.stringify({
    tasks: [],
    taskWorkflowIds: [],
    cancelledTaskIds: [],
    schedules: [],
    history: [],
  });

  test("unschedule throws (not returns false) when remote delete succeeds but persist fails", async () => {
    const { mkdirSync, writeFileSync, chmodSync, rmdirSync } = await import("node:fs");
    const client = makeMockClient();
    // Set up a writable dir, create a schedule, then make dir read-only before unschedule.
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(dbPath, VALID_INITIAL_STATE);
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const scheduleId = await scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "dispatch");
    await scheduler[Symbol.asyncDispose]();
    // Re-open the scheduler while still writable (acquires lock), then block writes.
    const scheduler2 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    chmodSync(dir, 0o555);
    await expect(scheduler2.unschedule(scheduleId)).rejects.toThrow(/durability write failed/);
    chmodSync(dir, 0o755);
    rmdirSync(dir, { recursive: true });
    await scheduler2[Symbol.asyncDispose]();
  });

  test("cyclic workflow result does not poison future persists", async () => {
    let resolveResult!: (value: unknown) => void;
    const resultPromise = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const client = makeMockClient({ getResult: mock(async () => resultPromise) });

    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    // Resolve with a cyclic object — should not break future persists
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    resolveResult(cyclic);
    await new Promise((r) => setTimeout(r, 20));

    // Submit a second task — if cyclic result poisoned persist, this would throw
    const id2 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(typeof id2).toBe("string");

    await scheduler[Symbol.asyncDispose]();
  });
});

describe("fail-closed durability guard (assertDurabilityOk)", () => {
  test("subsequent submit throws after background persist failure", async () => {
    let callCount = 0;
    let resolveFirst!: (value: unknown) => void;
    const firstResult = new Promise<unknown>((r) => {
      resolveFirst = r;
    });
    const client = makeMockClient({
      getResult: mock(async () => {
        callCount++;
        if (callCount === 1) return firstResult;
        return new Promise<unknown>(() => {});
      }),
    });

    const _dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const { writeFileSync } = await import("node:fs");
    // Pre-create a valid state file, then make it unwritable after scheduler starts.
    // We'll block writes after the first submit so the second persist (on completion) fails.
    const { mkdirSync, chmodSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath2 = `${dir}/state.json`;
    writeFileSync(
      dbPath2,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
      }),
    );
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath: dbPath2 });
    // First submit succeeds (writes initial running state while dir is writable)
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    // Block writes so the background completion persist fails
    chmodSync(dir, 0o555);

    // Complete the workflow — background persist will fail and set durabilityFailed
    resolveFirst({ ok: true });
    await new Promise((r) => setTimeout(r, 50));

    // Now subsequent mutations should throw fail-closed
    await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(/fail-closed/);

    chmodSync(dir, 0o755);
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("submit — input serialization guard (dbPath)", () => {
  test("rejects non-serializable resume.state before remote call when dbPath is set", async () => {
    const client = makeMockClient();
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const badInput = { kind: "resume", state: circular } as unknown as EngineInput;
    await expect(scheduler.submit(AGENT_ID, badInput, "dispatch")).rejects.toThrow(
      /non-JSON-serializable/,
    );
    // Remote call must NOT have been made
    expect(client.workflow.signal).not.toHaveBeenCalled();
    await scheduler[Symbol.asyncDispose]();
  });

  test("rejects function in resume.state when dbPath is set", async () => {
    const client = makeMockClient();
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const fnInput = { kind: "resume", state: { fn: () => "x" } } as unknown as EngineInput;
    await expect(scheduler.submit(AGENT_ID, fnInput, "dispatch")).rejects.toThrow(
      /non-JSON-serializable/,
    );
    expect(client.workflow.signal).not.toHaveBeenCalled();
    await scheduler[Symbol.asyncDispose]();
  });

  test("allows serializable resume.state when dbPath is set", async () => {
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const scheduler = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    const goodInput = {
      kind: "resume",
      state: { count: 42, name: "agent" },
    } as unknown as EngineInput;
    const id = await scheduler.submit(AGENT_ID, goodInput, "dispatch");
    expect(typeof id).toBe("string");
    await scheduler[Symbol.asyncDispose]();
  });

  test("rejects non-serializable input even when dbPath is not set", async () => {
    // Validation is now unconditional — matches schedule() path behavior.
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const badInput = { kind: "resume", state: circular } as unknown as EngineInput;
    await expect(scheduler.submit(AGENT_ID, badInput, "dispatch")).rejects.toThrow(
      /non-JSON-serializable/,
    );
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("pause / resume — compensation on persist failure", () => {
  const VALID_INITIAL_STATE = JSON.stringify({
    tasks: [],
    taskWorkflowIds: [],
    cancelledTaskIds: [],
    schedules: [],
    history: [],
  });

  async function makeSchedulerWithLockedDir(client: TemporalClientLike): Promise<{
    scheduler: ReturnType<typeof createTemporalScheduler>;
    scheduleId: string;
    lockDir: () => void;
    cleanup: () => void;
  }> {
    const { mkdirSync, writeFileSync, chmodSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(dbPath, VALID_INITIAL_STATE);
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const scheduleId = String(await scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn"));
    return {
      scheduler,
      scheduleId,
      lockDir: () => chmodSync(dir, 0o555),
      cleanup: () => {
        chmodSync(dir, 0o755);
        rmdirSync(dir, { recursive: true });
      },
    };
  }

  test("pause compensates with unpause when persist fails", async () => {
    const client = makeMockClient();
    const { scheduler, scheduleId, lockDir, cleanup } = await makeSchedulerWithLockedDir(client);
    lockDir();
    try {
      await expect(scheduler.pause(scheduleId as never)).rejects.toThrow(/durability write failed/);
      // Remote compensation: unpause reverses the pause so Temporal matches on-disk state
      expect(client.schedule.unpause).toHaveBeenCalled();
    } finally {
      cleanup();
      await scheduler[Symbol.asyncDispose]();
    }
  });

  test("resume compensates with pause when persist fails", async () => {
    const client = makeMockClient();
    const { scheduler, scheduleId, lockDir, cleanup } = await makeSchedulerWithLockedDir(client);
    // Pause while dir is writable
    await scheduler.pause(scheduleId as never);
    lockDir();
    try {
      await expect(scheduler.resume(scheduleId as never)).rejects.toThrow(
        /durability write failed/,
      );
      // client.schedule.pause: once for the initial pause + once for compensation
      expect(client.schedule.pause).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      await scheduler[Symbol.asyncDispose]();
    }
  });
});

describe("two-phase pre-commit", () => {
  test("spawn: task is queryable as 'pending' before workflow.start completes", async () => {
    let pendingCount = 0;
    let schedulerRef: ReturnType<typeof createTemporalScheduler> | undefined;
    const client = makeMockClient({
      start: mock(async () => {
        // Inspect in-memory state mid-start — pre-commit must have already happened.
        pendingCount = ((await schedulerRef?.query({})) ?? []).filter(
          (t) => t.status === "pending",
        ).length;
        return { workflowId: "wf-1" };
      }),
    });
    schedulerRef = createTemporalScheduler(makeConfig(client));
    await schedulerRef.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(pendingCount).toBe(1);
    await schedulerRef[Symbol.asyncDispose]();
  });

  test("dispatch: task is visible as 'pending' during signal() after pre-commit", async () => {
    let pendingCount = 0;
    let schedulerRef: ReturnType<typeof createTemporalScheduler> | undefined;
    const client = makeMockClient({
      signal: mock(async () => {
        pendingCount = ((await schedulerRef?.query({})) ?? []).filter(
          (t) => t.status === "pending",
        ).length;
      }),
    });
    schedulerRef = createTemporalScheduler(makeConfig(client));
    await schedulerRef.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    // Dispatch now pre-commits so the task is visible as "pending" during signal().
    expect(pendingCount).toBe(1);
    await schedulerRef[Symbol.asyncDispose]();
  });

  test("schedule: pendingScheduleId is persisted before schedule.create completes", async () => {
    const { readFileSync } = await import("node:fs");
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    let preCommitState: { pendingSchedules?: unknown[] } | undefined;
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        signal: mock(async () => undefined),
        cancel: mock(async () => undefined),
        getResult: mock(async () => new Promise<unknown>(() => {})),
      },
      schedule: {
        create: mock(async () => {
          preCommitState = JSON.parse(readFileSync(dbPath, "utf-8")) as {
            pendingSchedules?: unknown[];
          };
        }),
        delete: mock(async () => undefined),
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
        getHandle: mock(() => ({
          describe: mock(async () => {
            throw new Error("schedule not found");
          }),
        })),
      },
    };
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn");
    // The pre-commit must have written one pending schedule (with full metadata) before remote create.
    expect(preCommitState?.pendingSchedules).toHaveLength(1);
    await scheduler[Symbol.asyncDispose]();
  });

  test("schedule: pendingScheduleId removed from persisted state after success", async () => {
    const { readFileSync } = await import("node:fs");
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const scheduler = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    await scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const state = JSON.parse(readFileSync(dbPath, "utf-8")) as { pendingScheduleIds?: string[] };
    expect(state.pendingScheduleIds).toHaveLength(0);
    await scheduler[Symbol.asyncDispose]();
  });

  test("spawn pre-commit persist failure aborts before workflow.start", async () => {
    const { mkdirSync, writeFileSync, chmodSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
        pendingScheduleIds: [],
      }),
    );
    const client = makeMockClient();
    // Create scheduler while dir is still writable so the advisory lock file can be written.
    // Then block writes so the pre-commit persist() call inside submit() fails.
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    chmodSync(dir, 0o555);
    try {
      await expect(scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(
        /durability write failed/,
      );
      // Remote call must NOT have been made — pre-commit failure aborts early.
      expect(client.workflow.start).not.toHaveBeenCalled();
    } finally {
      chmodSync(dir, 0o755);
      rmdirSync(dir, { recursive: true });
      await scheduler[Symbol.asyncDispose]();
    }
  });
});

describe("idempotencyKey", () => {
  test("dispatch: stable task ID across calls with same idempotencyKey", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id1 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", {
      idempotencyKey: "stable-key",
    });
    // Retry with the same key
    const id2 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", {
      idempotencyKey: "stable-key",
    });
    // ID is namespaced: agentId:mode:key — prevents cross-agent key collisions.
    expect(String(id1)).toBe(`${AGENT_ID}:dispatch:stable-key`);
    expect(String(id2)).toBe(`${AGENT_ID}:dispatch:stable-key`);
    await scheduler[Symbol.asyncDispose]();
  });

  test("dispatch: idempotency guard prevents second signal for same key", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id1 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", {
      idempotencyKey: "idem-1",
    });
    // Second call with same key: idempotency guard returns early, no second signal sent.
    const id2 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", {
      idempotencyKey: "idem-1",
    });
    expect(id1).toBe(id2);
    expect(client.workflow.signal).toHaveBeenCalledTimes(1);
    await scheduler[Symbol.asyncDispose]();
  });

  test("dispatch: first signal message IDs derived from idempotencyKey", async () => {
    const signalArgs: unknown[][] = [];
    const client = makeMockClient({
      signal: mock(async (...args: unknown[]) => {
        signalArgs.push(args as unknown[]);
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", { idempotencyKey: "idem-1" });
    const msgs = signalArgs[0]?.[2] as Array<{ id: string }> | undefined;
    expect(msgs?.[0]?.id).toBe(`${AGENT_ID}:dispatch:idem-1:0`);
    await scheduler[Symbol.asyncDispose]();
  });

  test("spawn: idempotency guard prevents second workflow.start for same key", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id1 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", {
      idempotencyKey: "spawn-key",
    });
    // Second call with same key while workflow is in-flight: guard returns early.
    const id2 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", {
      idempotencyKey: "spawn-key",
    });
    expect(id1).toBe(id2);
    expect(client.workflow.start).toHaveBeenCalledTimes(1);
    await scheduler[Symbol.asyncDispose]();
  });

  test("without idempotencyKey: task IDs are unique per call", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    const id1 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    const id2 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");
    expect(id1).not.toBe(id2);
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("idempotent spawn — retry after cancel does not attach to cancelling workflow", () => {
  test("already-running error on retry-after-cancel throws instead of attaching to cancelled run", async () => {
    // Simulate: workflow is still shutting down from cancel when retry calls workflow.start().
    // The "already running" rejection must NOT be treated as an ambiguous success.
    let _getResultCalled = 0;
    const client = makeMockClient({
      start: mock(async () => {
        throw new Error("Workflow execution already started");
      }),
      cancel: mock(async () => undefined),
      getResult: mock(async () => {
        _getResultCalled++;
        return Promise.resolve("result");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    // First submit succeeds (start mock isn't the first call - the default mock succeeds).
    // We need a different setup: first call to start() succeeds, then cancel(), then retry fails.
    await scheduler[Symbol.asyncDispose]();

    // Fresh scheduler: start succeeds first, then we cancel, then retry start with "already running".
    let callCount = 0;
    const client2 = makeMockClient({
      start: mock(async () => {
        callCount++;
        if (callCount === 1) return { workflowId: `${AGENT_ID}:spawn:cancel-retry` };
        throw new Error("Workflow execution already started"); // retry hits shutting-down workflow
      }),
      cancel: mock(async () => undefined),
      getResult: mock(async () => new Promise(() => {})), // never resolves (workflow running)
    });
    const s = createTemporalScheduler(makeConfig(client2));
    const id = await s.submit(AGENT_ID, TEXT_INPUT, "spawn", { idempotencyKey: "cancel-retry" });
    expect(typeof id).toBe("string");

    // Cancel the workflow.
    await s.cancel(id);

    // Retry with the same idempotencyKey — should throw because it's a retry-after-cancel
    // and "already running" reflects the cancelling workflow, not a fresh one.
    await expect(
      s.submit(AGENT_ID, TEXT_INPUT, "spawn", { idempotencyKey: "cancel-retry" }),
    ).rejects.toThrow(/already started/i);

    await s[Symbol.asyncDispose]();
  });
});

describe("idempotent spawn — definite rejection throws immediately", () => {
  test("non-ambiguous start failure (e.g. auth error) throws rather than returning running state", async () => {
    // A definite rejection (e.g. permission denied, bad workflow type) should NOT be
    // treated as an ambiguous ACK-lost scenario. The task was never created.
    const client = makeMockClient({
      start: mock(async () => {
        throw new Error("PERMISSION_DENIED: workflow type not registered");
      }),
    });
    const events: string[] = [];
    const scheduler = createTemporalScheduler(makeConfig(client));
    scheduler.watch((e) => events.push(e.kind));
    await expect(
      scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", { idempotencyKey: "perm-denied" }),
    ).rejects.toThrow("PERMISSION_DENIED");
    // cancel must NOT be called (idempotencyKey present)
    expect(client.workflow.cancel).not.toHaveBeenCalled();
    // task should be failed, not running
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("failed");
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("idempotencyKey — delimiter validation prevents ID aliasing", () => {
  test("idempotencyKey containing ':' is rejected to prevent cross-agent ID collision", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", { idempotencyKey: "agent:x:key" }),
    ).rejects.toThrow(/idempotencyKey must not contain ':'/);
    await scheduler[Symbol.asyncDispose]();
  });

  test("agentId containing ':' is rejected when idempotencyKey is set", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    const colonAgentId = "agent:with:colons" as AgentId;
    await expect(
      scheduler.submit(colonAgentId, TEXT_INPUT, "dispatch", { idempotencyKey: "key" }),
    ).rejects.toThrow(/agentId must not contain ':'/);
    await scheduler[Symbol.asyncDispose]();
  });

  test("schedule() rejects idempotencyKey — not a dedup primitive for scheduled firings", async () => {
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await expect(
      scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn", {
        idempotencyKey: "my-key",
      }),
    ).rejects.toThrow(/does not support.*idempotencyKey/);
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("idempotencyKey — failed submissions allow retry", () => {
  test("ambiguous dispatch signal failure — does not throw, marks completed, idempotency guards retry", async () => {
    // Ambiguous signal failures (transport-level — could be delivered) are treated as optimistically
    // delivered to prevent duplicate dispatch on caller retry. The caller receives the task ID and
    // does NOT retry. A second call with the same idempotencyKey is a no-op (task already completed).
    let callCount = 0;
    const client = makeMockClient({
      signal: mock(async () => {
        callCount++;
        if (callCount === 1) throw new Error("ECONNRESET: connection reset by peer");
      }),
    });
    const scheduler = createTemporalScheduler(makeConfig(client));
    // First attempt: signal throws "ECONNRESET" — treated as possibly delivered, does NOT throw
    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", {
      idempotencyKey: "retry-key",
    });
    expect(String(id)).toBe(`${AGENT_ID}:dispatch:retry-key`);
    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("completed"); // optimistic delivery
    // Second call with same key — idempotency guard short-circuits (already completed), no second signal
    const id2 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", {
      idempotencyKey: "retry-key",
    });
    expect(id2).toBe(id);
    expect(client.workflow.signal).toHaveBeenCalledTimes(1); // no duplicate signal
    await scheduler[Symbol.asyncDispose]();
  });

  test("retrying a succeeded dispatch with same key is a no-op", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", { idempotencyKey: "ok-key" });
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch", { idempotencyKey: "ok-key" });
    // Second call must not produce a second signal
    expect(client.workflow.signal).toHaveBeenCalledTimes(1);
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("idempotencyKey — cancel-then-retry spawn records completion", () => {
  test("cancel followed by retry with same key allows getResult to record completion", async () => {
    let resolveResult!: (v: unknown) => void;
    const resultPromise = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const client = makeMockClient({ getResult: mock(async () => resultPromise) });
    const scheduler = createTemporalScheduler(makeConfig(client));
    // First submit
    const id1 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", {
      idempotencyKey: "cxr-key",
    });
    // Cancel the task — adds id to cancelledTaskIds
    await scheduler.cancel(id1);
    // Retry with same key (task is now "failed" due to cancel)
    const id2 = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", {
      idempotencyKey: "cxr-key",
    });
    expect(id1).toBe(id2);
    // Workflow completes — getResult resolves
    resolveResult({ done: true });
    await new Promise((r) => setTimeout(r, 20));
    // The completion must be recorded — cancelledTaskIds was cleared on retry
    const tasks = await scheduler.query({});
    const completedTask = tasks.find((t) => t.id === id2);
    expect(completedTask?.status ?? "completed").toBe("completed");
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("dispatch deliveredDispatchIds — prevents duplicate signal after restart", () => {
  test("restart with deliveredDispatchIds marks task completed, not failed", async () => {
    const { mkdirSync, writeFileSync, readFileSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
        pendingScheduleIds: [],
      }),
    );
    const client = makeMockClient();
    const s1 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const id = await s1.submit(AGENT_ID, TEXT_INPUT, "dispatch", { idempotencyKey: "dedup-key" });
    // s1 persisted task as completed; deliveredDispatchIds should not appear in history.
    await s1[Symbol.asyncDispose]();
    // Manually corrupt snapshot: put the task back as "pending" with deliveredDispatchIds
    const state = JSON.parse(readFileSync(dbPath, "utf-8")) as Record<string, unknown>;
    const taskId = id;
    const manipulated = {
      ...state,
      tasks: [
        [
          taskId,
          {
            id: taskId,
            agentId: AGENT_ID,
            mode: "dispatch",
            input: { kind: "text", text: "hello" },
            priority: 0,
            status: "pending",
            createdAt: Date.now(),
            retries: 0,
            maxRetries: 3,
          },
        ],
      ],
      deliveredDispatchIds: [taskId],
      history: [],
    };
    writeFileSync(dbPath, JSON.stringify(manipulated));
    // Second scheduler: should see the deliveredDispatchIds and mark task as completed (not failed)
    const s2 = createTemporalScheduler({ ...makeConfig(client), dbPath });
    const hist = await s2.history({});
    const record = hist.find((r) => r.taskId === taskId);
    expect(record?.status).toBe("completed");
    // Second submit with same key must be a no-op (task is completed — not retried)
    await s2.submit(AGENT_ID, TEXT_INPUT, "dispatch", { idempotencyKey: "dedup-key" });
    expect(client.workflow.signal).toHaveBeenCalledTimes(1); // only the first one from s1
    rmdirSync(dir, { recursive: true });
    await s2[Symbol.asyncDispose]();
  });
});

describe("startup reconciliation — persisted so second restart does not duplicate history", () => {
  test("history is not duplicated when the same pending dispatch snapshot is loaded twice", async () => {
    const { mkdirSync, writeFileSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    // Simulate a crash: pending dispatch task on disk, no deliveredDispatchIds.
    const taskId = `${AGENT_ID}:dispatch:crash-key`;
    const crashSnapshot = JSON.stringify({
      tasks: [
        [
          taskId,
          {
            id: taskId,
            agentId: AGENT_ID,
            mode: "dispatch",
            input: { kind: "text", text: "hello" },
            priority: 0,
            status: "pending",
            createdAt: Date.now(),
            retries: 0,
            maxRetries: 3,
          },
        ],
      ],
      taskWorkflowIds: [],
      cancelledTaskIds: [],
      schedules: [],
      history: [],
      pendingScheduleIds: [],
      deliveredDispatchIds: [],
    });
    writeFileSync(dbPath, crashSnapshot);

    // First restart: reconciliation marks task as "completed" (optimistic delivery) and persists.
    // Delivery-unknown dispatch tasks are marked completed, not failed, to prevent retries that
    // would re-send with a different task ID and produce duplicate signals.
    const s1 = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    const hist1 = await s1.history({});
    expect(hist1).toHaveLength(1);
    expect(hist1[0]?.status).toBe("completed");
    await s1[Symbol.asyncDispose]();

    // Second restart from the same dbPath: reconciliation must NOT run again (already committed).
    const s2 = createTemporalScheduler({ ...makeConfig(makeMockClient()), dbPath });
    const hist2 = await s2.history({});
    // History must still be exactly 1 record — no duplicate from replaying the recovery.
    expect(hist2).toHaveLength(1);
    expect(hist2[0]?.status).toBe("completed");
    await s2[Symbol.asyncDispose]();
    rmdirSync(dir, { recursive: true });
  });
});

describe("maxStopRetries — preserved through submit and schedule payloads", () => {
  test("submit passes maxStopRetries through to the workflow start args", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, { kind: "text", text: "hi", maxStopRetries: 7 }, "spawn");
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const args = (startArgs?.[1] as Record<string, unknown>)?.args as unknown[];
    // AgentWorkflowConfig is the direct spawn arg — maxStopRetries sits at the top level.
    const spawnArg = args?.[0] as Record<string, unknown> | undefined;
    expect(spawnArg?.maxStopRetries).toBe(7);
    await scheduler[Symbol.asyncDispose]();
  });

  test("submit with no maxStopRetries omits it from the AgentWorkflowConfig", async () => {
    const client = makeMockClient();
    const scheduler = createTemporalScheduler(makeConfig(client));
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const args = (startArgs?.[1] as Record<string, unknown>)?.args as unknown[];
    const spawnArg = args?.[0] as Record<string, unknown> | undefined;
    expect("maxStopRetries" in (spawnArg ?? {})).toBe(false);
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("schedule() — create error path retains pending marker on failed delete", () => {
  test("pendingScheduleIds NOT cleared when create fails and delete also fails", async () => {
    const { readFileSync, writeFileSync, mkdirSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
        pendingScheduleIds: [],
      }),
    );
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        signal: mock(async () => undefined),
        cancel: mock(async () => undefined),
        getResult: mock(async () => new Promise<unknown>(() => {})),
      },
      schedule: {
        create: mock(async () => {
          throw new Error("create timeout — schedule may exist");
        }),
        delete: mock(async () => {
          throw new Error("delete failed");
        }),
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
        getHandle: mock(() => ({
          describe: mock(async () => {
            throw new Error("schedule not found");
          }),
        })),
      },
    };
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await expect(scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(
      "create timeout",
    );
    const state = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      pendingSchedules?: { id: string }[];
    };
    // Delete also failed → pending schedule (with metadata) must remain for restart reconciliation
    expect(state.pendingSchedules?.length).toBe(1);
    rmdirSync(dir, { recursive: true });
    await scheduler[Symbol.asyncDispose]();
  });

  test("pendingScheduleIds IS cleared when create fails and delete succeeds", async () => {
    const { readFileSync, writeFileSync, mkdirSync, rmdirSync } = await import("node:fs");
    const dir = `/tmp/temporal-test-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const dbPath = `${dir}/state.json`;
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
        pendingScheduleIds: [],
      }),
    );
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        signal: mock(async () => undefined),
        cancel: mock(async () => undefined),
        getResult: mock(async () => new Promise<unknown>(() => {})),
      },
      schedule: {
        create: mock(async () => {
          throw new Error("create failed");
        }),
        delete: mock(async () => undefined), // delete succeeds
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
        getHandle: mock(() => ({
          describe: mock(async () => {
            throw new Error("schedule not found");
          }),
        })),
      },
    };
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await expect(scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(
      "create failed",
    );
    const state = JSON.parse(readFileSync(dbPath, "utf-8")) as { pendingSchedules?: unknown[] };
    // Delete succeeded → pending schedule cleared from disk
    expect(state.pendingSchedules?.length).toBe(0);
    rmdirSync(dir, { recursive: true });
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("input snapshot — caller mutation safety", () => {
  test("mutating input object after submit does not affect stored task", async () => {
    const input = { kind: "text", text: "original" } as unknown as EngineInput;
    const scheduler = createTemporalScheduler(makeConfig(makeMockClient()));
    await scheduler.submit(AGENT_ID, input, "spawn");
    // Mutate after submit
    (input as unknown as Record<string, unknown>).text = "mutated";
    const tasks = await scheduler.query({});
    // Stored task should still reflect the original text
    const storedInput = tasks[0]?.input as { text?: string } | undefined;
    expect(storedInput?.text).toBe("original");
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("pending-schedule cleanup — query-first, no blind deletion", () => {
  test("cleanup retains pendingScheduleId when describe throws a transient error", async () => {
    // Transient describe failure (connection error) — keep the ID so the next restart retries.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const pendingId = "sched:pending-123";
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
        pendingScheduleIds: [pendingId],
      }),
    );
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        signal: mock(async () => undefined),
        cancel: mock(async () => undefined),
        getResult: mock(async () => new Promise<unknown>(() => {})),
      },
      schedule: {
        create: mock(async () => undefined),
        delete: mock(async () => undefined),
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
        getHandle: mock(() => ({
          describe: mock(async () => {
            throw new Error("UNAVAILABLE: upstream connect error"); // transient, not "not found"
          }),
        })),
      },
    };
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await new Promise((r) => setTimeout(r, 50));
    const state = JSON.parse(readFileSync(dbPath, "utf-8")) as { pendingScheduleIds?: string[] };
    // Transient error — pending ID must NOT have been cleared from disk
    expect(state.pendingScheduleIds).toContain(pendingId);
    // Schedule must NOT have been deleted
    expect(client.schedule.delete).not.toHaveBeenCalled();
    await scheduler[Symbol.asyncDispose]();
  });

  test("cleanup clears pendingScheduleId when schedule does not exist in Temporal", async () => {
    // create() never completed — schedule is not-found. Clear the marker, nothing to clean up.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const pendingId = "sched:pending-456";
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
        pendingScheduleIds: [pendingId],
      }),
    );
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        signal: mock(async () => undefined),
        cancel: mock(async () => undefined),
        getResult: mock(async () => new Promise<unknown>(() => {})),
      },
      schedule: {
        create: mock(async () => undefined),
        delete: mock(async () => undefined),
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
        getHandle: mock(() => ({
          describe: mock(async () => {
            throw new Error("schedule not found"); // definite not-found
          }),
        })),
      },
    };
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await new Promise((r) => setTimeout(r, 50));
    const state = JSON.parse(readFileSync(dbPath, "utf-8")) as { pendingScheduleIds?: string[] };
    // Not-found → cleared
    expect(state.pendingScheduleIds).not.toContain(pendingId);
    // No delete call — nothing to remove
    expect(client.schedule.delete).not.toHaveBeenCalled();
    await scheduler[Symbol.asyncDispose]();
  });

  test("cleanup clears pendingScheduleId without deleting when schedule exists in Temporal", async () => {
    // create() succeeded before crash — schedule is alive. Do NOT delete. Clear the marker.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const dbPath = `/tmp/temporal-test-${crypto.randomUUID()}.json`;
    const pendingId = "sched:pending-789";
    writeFileSync(
      dbPath,
      JSON.stringify({
        tasks: [],
        taskWorkflowIds: [],
        cancelledTaskIds: [],
        schedules: [],
        history: [],
        pendingScheduleIds: [pendingId],
      }),
    );
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        signal: mock(async () => undefined),
        cancel: mock(async () => undefined),
        getResult: mock(async () => new Promise<unknown>(() => {})),
      },
      schedule: {
        create: mock(async () => undefined),
        delete: mock(async () => undefined),
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
        getHandle: mock(() => ({
          describe: mock(async () => ({ scheduleId: pendingId })), // schedule exists
        })),
      },
    };
    const scheduler = createTemporalScheduler({ ...makeConfig(client), dbPath });
    await new Promise((r) => setTimeout(r, 50));
    const state = JSON.parse(readFileSync(dbPath, "utf-8")) as { pendingScheduleIds?: string[] };
    // Schedule existed → marker cleared (schedule kept alive)
    expect(state.pendingScheduleIds).not.toContain(pendingId);
    // MUST NOT have deleted the live schedule
    expect(client.schedule.delete).not.toHaveBeenCalled();
    await scheduler[Symbol.asyncDispose]();
  });
});

describe("schedule() — idempotent on create failure", () => {
  test("schedule.create failure triggers immediate best-effort delete", async () => {
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        signal: mock(async () => undefined),
        cancel: mock(async () => undefined),
        getResult: mock(async () => new Promise<unknown>(() => {})),
      },
      schedule: {
        create: mock(async () => {
          throw new Error("create failed after schedule created");
        }),
        delete: mock(async () => undefined),
        pause: mock(async () => undefined),
        unpause: mock(async () => undefined),
        getHandle: mock(() => ({
          describe: mock(async () => {
            throw new Error("schedule not found");
          }),
        })),
      },
    };
    const scheduler = createTemporalScheduler(makeConfig(client));
    await expect(scheduler.schedule("0 * * * *", AGENT_ID, TEXT_INPUT, "spawn")).rejects.toThrow(
      "create failed",
    );
    // Immediate best-effort delete must have been called to prevent orphan schedule
    expect(client.schedule.delete).toHaveBeenCalledTimes(1);
    await scheduler[Symbol.asyncDispose]();
  });
});

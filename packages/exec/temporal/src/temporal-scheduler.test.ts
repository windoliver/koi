/**
 * Tests for Temporal-backed TaskScheduler.
 * Decision 12A: Must pass L0 contract test suite.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentId, EngineInput } from "@koi/core";
import {
  createTemporalScheduler,
  type TemporalClientLike,
  type TemporalSchedulerConfig,
} from "./temporal-scheduler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): TemporalClientLike {
  return {
    workflow: {
      start: mock(async () => ({ workflowId: "wf-1" })),
      signal: mock(async () => undefined),
      cancel: mock(async () => undefined),
    },
    schedule: {
      create: mock(async () => undefined),
      delete: mock(async () => undefined),
      pause: mock(async () => undefined),
      unpause: mock(async () => undefined),
    },
  };
}

function createTestConfig(client: TemporalClientLike): TemporalSchedulerConfig {
  return {
    client,
    taskQueue: "test-queue",
    workflowType: "agentWorkflow",
  };
}

const AGENT_ID = "agent-1" as AgentId;
const TEXT_INPUT: EngineInput = { kind: "text", text: "hello" } as unknown as EngineInput;
const MESSAGES_INPUT: EngineInput = {
  kind: "messages",
  messages: [{ content: [{ kind: "text", text: "from message" }], senderId: "u1", timestamp: 1 }],
} as unknown as EngineInput;
const RESUME_INPUT: EngineInput = { kind: "resume", state: {} } as unknown as EngineInput;

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

describe("submit", () => {
  test("returns a TaskId", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    expect(typeof id).toBe("string");
    expect(id).toContain("task:");
  });

  test("starts a Temporal workflow", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    expect(client.workflow.start).toHaveBeenCalledTimes(1);
  });

  test("signals the workflow with message", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");

    expect(client.workflow.signal).toHaveBeenCalledTimes(1);
  });

  test("emits task:submitted event", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));
    const events: unknown[] = [];
    scheduler.watch((e) => events.push(e));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    expect(events).toHaveLength(1);
    expect((events[0] as { kind: string }).kind).toBe("task:submitted");
  });

  test("applies priority from options", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", { priority: 1 });

    const tasks = await scheduler.query({ agentId: AGENT_ID });
    expect(tasks[0]?.priority).toBe(1);
  });

  test("defaults priority to 5", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    const tasks = await scheduler.query({});
    expect(tasks[0]?.priority).toBe(5);
  });

  test("converts text EngineInput to content array in signal", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    const payload = signalArgs?.[2] as { content: readonly unknown[] };
    expect(payload.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("converts messages EngineInput to content array in signal", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, MESSAGES_INPUT, "spawn");

    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    const payload = signalArgs?.[2] as { content: readonly unknown[] };
    expect(payload.content).toEqual([{ kind: "text", text: "from message" }]);
  });

  test("converts resume EngineInput to empty content array", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, RESUME_INPUT, "spawn");

    const signalArgs = (client.workflow.signal as ReturnType<typeof mock>).mock.calls[0];
    const payload = signalArgs?.[2] as { content: readonly unknown[] };
    expect(payload.content).toEqual([]);
  });

  test("passes startDelay when delayMs is set", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn", { delayMs: 5000 });

    const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0];
    const options = startArgs?.[1] as Record<string, unknown>;
    expect(options.startDelay).toBe("5000ms");
  });

  test("transitions task to running after signal", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    const tasks = await scheduler.query({});
    expect(tasks[0]?.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("cancel", () => {
  test("cancels an existing task", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    const result = await scheduler.cancel(id);

    expect(result).toBe(true);
    expect(client.workflow.cancel).toHaveBeenCalled();
  });

  test("returns false for unknown task", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const result = await scheduler.cancel("nonexistent" as never);

    expect(result).toBe(false);
  });

  test("emits task:cancelled event", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));
    const events: unknown[] = [];
    scheduler.watch((e) => events.push(e));

    const id = await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.cancel(id);

    const cancelEvents = events.filter((e) => (e as { kind: string }).kind === "task:cancelled");
    expect(cancelEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// schedule / unschedule
// ---------------------------------------------------------------------------

describe("schedule", () => {
  test("creates a Temporal schedule with initialMessage", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");

    expect(typeof id).toBe("string");
    expect(id).toContain("sched:");
    expect(client.schedule.create).toHaveBeenCalledTimes(1);

    // Verify initialMessage is passed in workflow args
    const createArgs = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0];
    const options = createArgs?.[1] as { action: { args: readonly [Record<string, unknown>] } };
    const workflowConfig = options.action.args[0];
    expect(workflowConfig).toHaveProperty("initialMessage");
    const msg = workflowConfig.initialMessage as { content: readonly unknown[] };
    expect(msg.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("emits schedule:created event", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));
    const events: unknown[] = [];
    scheduler.watch((e) => events.push(e));

    await scheduler.schedule("*/5 * * * *", AGENT_ID, TEXT_INPUT, "dispatch");

    const createEvents = events.filter((e) => (e as { kind: string }).kind === "schedule:created");
    expect(createEvents).toHaveLength(1);
  });

  test("unschedule removes the schedule", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const result = await scheduler.unschedule(id);

    expect(result).toBe(true);
    expect(client.schedule.delete).toHaveBeenCalledTimes(1);
  });

  test("unschedule returns false for unknown schedule", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const result = await scheduler.unschedule("nonexistent" as never);

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

describe("pause / resume", () => {
  test("pause pauses a schedule", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    const result = await scheduler.pause(id);

    expect(result).toBe(true);
    expect(client.schedule.pause).toHaveBeenCalledTimes(1);
  });

  test("resume resumes a paused schedule", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const id = await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.pause(id);
    const result = await scheduler.resume(id);

    expect(result).toBe(true);
    expect(client.schedule.unpause).toHaveBeenCalledTimes(1);
  });

  test("pause returns false for unknown schedule", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const result = await scheduler.pause("nonexistent" as never);

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// query / stats / history
// ---------------------------------------------------------------------------

describe("query / stats", () => {
  test("query returns tasks matching filter", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "dispatch");

    const allTasks = await scheduler.query({});
    expect(allTasks).toHaveLength(2);

    const spawnTasks = await scheduler.query({ agentId: AGENT_ID });
    expect(spawnTasks).toHaveLength(2);
  });

  test("query respects limit", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");

    const limited = await scheduler.query({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  test("stats reflects running task counts after submit", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler.schedule("0 0 * * *", AGENT_ID, TEXT_INPUT, "spawn");

    const s = await scheduler.stats();
    // Tasks transition to "running" after signal
    expect(s.running).toBe(1);
    expect(s.activeSchedules).toBe(1);
  });

  test("history returns empty for fresh scheduler", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    const records = await scheduler.history({});
    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

describe("watch", () => {
  test("unsubscribe stops event delivery", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));
    const events: unknown[] = [];
    const unsub = scheduler.watch((e) => events.push(e));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(events).toHaveLength(1);

    unsub();
    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    expect(events).toHaveLength(1); // No new events
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("clears all state on dispose", async () => {
    const client = createMockClient();
    const scheduler = createTemporalScheduler(createTestConfig(client));

    await scheduler.submit(AGENT_ID, TEXT_INPUT, "spawn");
    await scheduler[Symbol.asyncDispose]();

    const remaining = await scheduler.query({});
    expect(remaining).toHaveLength(0);
    const stats = await scheduler.stats();
    expect(stats.pending).toBe(0);
  });
});

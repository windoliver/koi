import { describe, expect, test } from "bun:test";
import type { SchedulerAdminClientLike } from "./scheduler-admin-adapter.js";
import { createSchedulerAdminAdapter } from "./scheduler-admin-adapter.js";

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function createMockClient(overrides?: Partial<SchedulerAdminClientLike>): SchedulerAdminClientLike {
  return {
    query: () => [
      {
        id: "task-1",
        agentId: "agent:test",
        status: "running" as const,
        priority: 5,
        createdAt: 1000,
        startedAt: 2000,
        retries: 0,
      },
      {
        id: "task-2",
        agentId: "agent:test",
        status: "completed" as const,
        priority: 3,
        createdAt: 500,
        completedAt: 3000,
        retries: 1,
      },
    ],
    stats: () => ({
      pending: 2,
      running: 1,
      completed: 10,
      failed: 3,
      deadLettered: 1,
      activeSchedules: 2,
      pausedSchedules: 0,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSchedulerAdminAdapter", () => {
  test("listTasks maps tasks to summaries", async () => {
    const adapter = createSchedulerAdminAdapter(createMockClient());
    const tasks = await adapter.views.listTasks();

    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.taskId).toBe("task-1");
    expect(tasks[0]?.status).toBe("running");
    expect(tasks[0]?.priority).toBe(5);
    expect(tasks[0]?.submittedAt).toBe(1000);
    expect(tasks[0]?.startedAt).toBe(2000);
    expect(tasks[0]?.retryCount).toBe(0);

    expect(tasks[1]?.taskId).toBe("task-2");
    expect(tasks[1]?.completedAt).toBe(3000);
    expect(tasks[1]?.retryCount).toBe(1);
  });

  test("getStats maps aggregate statistics", async () => {
    const adapter = createSchedulerAdminAdapter(createMockClient());
    const stats = await adapter.views.getStats();

    expect(stats.submitted).toBe(17); // 2+1+10+3+1
    expect(stats.completed).toBe(10);
    expect(stats.failed).toBe(3);
    expect(stats.deadLetterCount).toBe(1);
    expect(stats.currentConcurrency).toBe(1);
  });

  test("listSchedules returns empty when client lacks listSchedules", async () => {
    const adapter = createSchedulerAdminAdapter(createMockClient());
    const schedules = await adapter.views.listSchedules();
    expect(schedules).toHaveLength(0);
  });

  test("listSchedules maps cron schedules when available", async () => {
    const client = {
      ...createMockClient(),
      listSchedules: () => [
        { id: "sched-1", expression: "0 0 * * *", paused: false, agentId: "agent:test" },
        { id: "sched-2", expression: "*/5 * * * *", paused: true, agentId: "agent:test" },
      ],
    };
    const adapter = createSchedulerAdminAdapter(client);
    const schedules = await adapter.views.listSchedules();

    expect(schedules).toHaveLength(2);
    expect(schedules[0]?.scheduleId).toBe("sched-1");
    expect(schedules[0]?.pattern).toBe("0 0 * * *");
    expect(schedules[0]?.active).toBe(true);
    expect(schedules[1]?.active).toBe(false);
  });

  test("listDeadLetters queries dead_letter status", async () => {
    const client = createMockClient({
      query: (filter) => {
        if (filter.status === "dead_letter") {
          return [
            {
              id: "dl-1",
              agentId: "agent:test",
              status: "dead_letter" as const,
              priority: 5,
              createdAt: 1000,
              completedAt: 5000,
              retries: 3,
              lastError: { message: "Max retries exceeded" },
            },
          ];
        }
        return [];
      },
    });
    const adapter = createSchedulerAdminAdapter(client);
    const entries = await adapter.views.listDeadLetters();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryId).toBe("dl-1");
    expect(entries[0]?.error).toBe("Max retries exceeded");
    expect(entries[0]?.retryCount).toBe(3);
  });

  test("pauseSchedule delegates to client.pause", async () => {
    const client = createMockClient({ pause: () => true });
    const adapter = createSchedulerAdminAdapter(client);
    const cmd = adapter.commands.pauseSchedule;
    if (cmd === undefined) throw new Error("expected pauseSchedule command");
    const result = await cmd("sched-1");
    expect(result.ok).toBe(true);
  });

  test("pauseSchedule is undefined when client.pause is not provided", () => {
    const adapter = createSchedulerAdminAdapter(createMockClient());
    expect(adapter.commands.pauseSchedule).toBeUndefined();
  });

  test("resumeSchedule delegates to client.resume", async () => {
    const client = createMockClient({ resume: () => true });
    const adapter = createSchedulerAdminAdapter(client);
    const cmd = adapter.commands.resumeSchedule;
    if (cmd === undefined) throw new Error("expected resumeSchedule command");
    const result = await cmd("sched-1");
    expect(result.ok).toBe(true);
  });

  test("deleteSchedule delegates to client.unschedule", async () => {
    const client = createMockClient({ unschedule: () => true });
    const adapter = createSchedulerAdminAdapter(client);
    const cmd = adapter.commands.deleteSchedule;
    if (cmd === undefined) throw new Error("expected deleteSchedule command");
    const result = await cmd("sched-1");
    expect(result.ok).toBe(true);
  });

  test("deleteSchedule returns NOT_FOUND when unschedule fails", async () => {
    const client = createMockClient({ unschedule: () => false });
    const adapter = createSchedulerAdminAdapter(client);
    const cmd = adapter.commands.deleteSchedule;
    if (cmd === undefined) throw new Error("expected deleteSchedule command");
    const result = await cmd("sched-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("retrySchedulerDeadLetter is always undefined (not yet supported)", () => {
    const adapter = createSchedulerAdminAdapter(createMockClient());
    expect(adapter.commands.retrySchedulerDeadLetter).toBeUndefined();
  });
});

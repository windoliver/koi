import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  CronSchedule,
  ScheduledTask,
  ScheduleStore,
  TaskQueueBackend,
  TaskStore,
} from "@koi/core";
import {
  migrateLocalSchedulerToNexus,
  type SchedulerMigrationReport,
} from "./scheduler-migration.js";

function fakeTask(taskOverrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1" as ScheduledTask["id"],
    agentId: "agent-a" as ScheduledTask["agentId"],
    input: { kind: "text", text: "hello" },
    mode: "dispatch",
    priority: 5,
    status: "pending",
    createdAt: 1_000,
    retries: 0,
    maxRetries: 3,
    ...taskOverrides,
  };
}

function fakeSchedule(scheduleOverrides: Partial<CronSchedule> = {}): CronSchedule {
  return {
    id: "sched-1" as CronSchedule["id"],
    expression: "*/5 * * * *",
    agentId: "agent-a" as CronSchedule["agentId"],
    input: { kind: "text", text: "hello" },
    mode: "dispatch",
    paused: false,
    ...scheduleOverrides,
  };
}

function createTaskStore(initial: readonly ScheduledTask[] = []): TaskStore {
  const tasks = new Map(initial.map((task) => [task.id, task] as const));

  return {
    async save(task) {
      tasks.set(task.id, task);
    },
    async load(id) {
      return tasks.get(id);
    },
    async remove(id) {
      tasks.delete(id);
    },
    async updateStatus(id, status, patch) {
      const existing = tasks.get(id);
      if (existing === undefined) {
        return;
      }
      tasks.set(id, {
        ...existing,
        status,
        ...(patch?.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch?.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        ...(patch?.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch?.retries !== undefined ? { retries: patch.retries } : {}),
      });
    },
    async query(filter) {
      return [...tasks.values()].filter((task) => {
        if (filter.agentId !== undefined && task.agentId !== filter.agentId) return false;
        if (filter.status !== undefined && task.status !== filter.status) return false;
        if (filter.priority !== undefined && task.priority !== filter.priority) return false;
        return true;
      });
    },
    async loadPending() {
      return [...tasks.values()].filter(
        (task) => task.status === "pending" || task.status === "running",
      );
    },
    async [Symbol.asyncDispose]() {},
  };
}

function createScheduleStore(initial: readonly CronSchedule[] = []): ScheduleStore {
  const schedules = new Map(initial.map((schedule) => [schedule.id, schedule] as const));

  return {
    async saveSchedule(schedule) {
      schedules.set(schedule.id, schedule);
    },
    async removeSchedule(id) {
      schedules.delete(id);
    },
    async loadSchedules() {
      return [...schedules.values()];
    },
    async [Symbol.asyncDispose]() {},
  };
}

function createQueueBackend() {
  const enqueued: ScheduledTask[] = [];

  const queue: TaskQueueBackend = {
    async enqueue(task) {
      enqueued.push(task);
      return task.id;
    },
    async cancel() {
      return false;
    },
    async status(taskId) {
      return enqueued.find((task) => task.id === taskId)?.status;
    },
    async [Symbol.asyncDispose]() {},
  };

  return { queue, enqueued };
}

const localFactoryState = {
  taskStore: createTaskStore(),
  scheduleStore: createScheduleStore(),
};

const nexusFactoryState = {
  calls: [] as unknown[],
  taskStore: createTaskStore(),
  scheduleStore: createScheduleStore(),
  queueBackend: createQueueBackend().queue,
};

const schedulerFactoryState = {
  calls: [] as unknown[][],
};

mock.module("@koi/core", () => ({
  DEFAULT_SCHEDULER_CONFIG: { kind: "default-config" },
  createSingleToolProvider: (provider: unknown) => provider,
}));

mock.module("@koi/scheduler", () => ({
  createSqliteTaskStore: () => localFactoryState.taskStore,
  createSqliteScheduleStore: () => localFactoryState.scheduleStore,
  createScheduler: (...args: unknown[]) => {
    schedulerFactoryState.calls.push(args);
    return { args };
  },
  createSchedulerComponent: (scheduler: unknown, agentId: unknown) => ({ scheduler, agentId }),
}));

mock.module("@koi/scheduler-provider", () => ({
  createSchedulerProvider: () =>
    Array.from({ length: 9 }, (_, index) => ({
      descriptor: { name: `tool-${index + 1}` },
    })),
}));

mock.module("@koi/scheduler-nexus", () => ({
  validateNexusSchedulerConfig: (config: unknown) => {
    if (config === null || config === undefined || typeof config !== "object") {
      return { ok: false, error: { code: "VALIDATION" } };
    }
    const value = config as Record<string, unknown>;
    if (typeof value.baseUrl !== "string" || value.baseUrl === "") {
      return { ok: false, error: { code: "VALIDATION" } };
    }
    return {
      ok: true,
      value: {
        baseUrl: value.baseUrl.replace(/\/+$/, ""),
        ...(value.visibilityTimeoutMs !== undefined
          ? { visibilityTimeoutMs: value.visibilityTimeoutMs }
          : {}),
        ...(value.fetch !== undefined ? { fetch: value.fetch } : {}),
      },
    };
  },
  createNexusSchedulerBackends: (config: unknown) => {
    nexusFactoryState.calls.push(config);
    return {
      taskStore: nexusFactoryState.taskStore,
      scheduleStore: nexusFactoryState.scheduleStore,
      queueBackend: nexusFactoryState.queueBackend,
    };
  },
}));

beforeEach(() => {
  localFactoryState.taskStore = createTaskStore();
  localFactoryState.scheduleStore = createScheduleStore();
  nexusFactoryState.calls = [];
  nexusFactoryState.taskStore = createTaskStore();
  nexusFactoryState.scheduleStore = createScheduleStore();
  nexusFactoryState.queueBackend = createQueueBackend().queue;
  schedulerFactoryState.calls = [];
});

async function importSchedulerModule() {
  return import(`./scheduler.js?cacheBust=${Date.now()}-${Math.random()}`);
}

describe("resolveSchedulerBackend", () => {
  test("falls back to local mode when Nexus config is absent", async () => {
    const { resolveSchedulerBackend } = await importSchedulerModule();
    expect(resolveSchedulerBackend({ host: {} })).toEqual({ kind: "local" });
  });

  test("falls back to local mode when Nexus config is invalid", async () => {
    const { resolveSchedulerBackend, SCHEDULER_NEXUS_HOST_KEY } = await importSchedulerModule();
    expect(
      resolveSchedulerBackend({
        host: {
          [SCHEDULER_NEXUS_HOST_KEY]: {
            baseUrl: "",
          },
        },
      }),
    ).toEqual({ kind: "local" });
  });

  test("parses Nexus mode when the host provides valid scheduler config", async () => {
    const { resolveSchedulerBackend, SCHEDULER_NEXUS_HOST_KEY } = await importSchedulerModule();
    const result = resolveSchedulerBackend({
      host: {
        [SCHEDULER_NEXUS_HOST_KEY]: {
          baseUrl: "http://nexus.test/",
          visibilityTimeoutMs: 30_000,
          fetch: (async () =>
            new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { schedules: [] } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })) as unknown as typeof globalThis.fetch,
        },
      },
    });

    expect(result).toEqual({
      kind: "nexus",
      config: {
        baseUrl: "http://nexus.test",
        visibilityTimeoutMs: 30_000,
        fetch: expect.any(Function),
      },
    });
  });
});

describe("schedulerStack", () => {
  test("activates with valid Nexus config and local migration sources", async () => {
    const {
      schedulerStack,
      SCHEDULER_LOCAL_SCHEDULE_STORE_HOST_KEY,
      SCHEDULER_LOCAL_TASK_STORE_HOST_KEY,
      SCHEDULER_NEXUS_HOST_KEY,
    } = await importSchedulerModule();
    const localTaskStore = createTaskStore();
    const localScheduleStore = createScheduleStore();
    const contribution = await schedulerStack.activate({
      cwd: process.cwd(),
      hostId: "test-host",
      host: {
        [SCHEDULER_NEXUS_HOST_KEY]: {
          baseUrl: "http://nexus.test",
          fetch: (async () =>
            new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { schedules: [] } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })) as unknown as typeof globalThis.fetch,
        },
        [SCHEDULER_LOCAL_TASK_STORE_HOST_KEY]: localTaskStore,
        [SCHEDULER_LOCAL_SCHEDULE_STORE_HOST_KEY]: localScheduleStore,
      },
    });

    expect(contribution.providers).toHaveLength(9);
    expect(nexusFactoryState.calls).toHaveLength(1);
    expect(schedulerFactoryState.calls[0]?.[1]).toBe(nexusFactoryState.taskStore);
    expect(schedulerFactoryState.calls[0]?.[4]).toBe(nexusFactoryState.scheduleStore);
    expect(schedulerFactoryState.calls[0]?.[5]).toEqual({
      queueBackend: nexusFactoryState.queueBackend,
      nodeId: "test-host",
    });
  });

  test("falls back to local scheduler stores when Nexus config is invalid", async () => {
    const { schedulerStack, SCHEDULER_NEXUS_HOST_KEY } = await importSchedulerModule();

    await schedulerStack.activate({
      cwd: process.cwd(),
      hostId: "test-host",
      host: {
        [SCHEDULER_NEXUS_HOST_KEY]: {
          baseUrl: "",
        },
      },
    });

    expect(nexusFactoryState.calls).toHaveLength(0);
    expect(schedulerFactoryState.calls[0]?.[1]).toBe(localFactoryState.taskStore);
    expect(schedulerFactoryState.calls[0]?.[4]).toBe(localFactoryState.scheduleStore);
  });
});

describe("migrateLocalSchedulerToNexus", () => {
  test("imports local schedules and pending tasks into Nexus stores", async () => {
    const localTaskStore = createTaskStore();
    const localScheduleStore = createScheduleStore();

    await localScheduleStore.saveSchedule(fakeSchedule());
    await localTaskStore.save(fakeTask());

    const nexusTaskStore = createTaskStore();
    const nexusScheduleStore = createScheduleStore();
    const { queue, enqueued } = createQueueBackend();

    const report = await migrateLocalSchedulerToNexus({
      localTaskStore,
      localScheduleStore,
      nexusTaskStore,
      nexusScheduleStore,
      nexusQueueBackend: queue,
    });

    expect(report).toEqual<SchedulerMigrationReport>({
      schedulesImported: 1,
      tasksImported: 1,
      skippedExistingSchedules: 0,
      skippedExistingTasks: 0,
    });
    expect(await nexusTaskStore.load("task-1" as ScheduledTask["id"])).toBeDefined();
    expect(await nexusScheduleStore.loadSchedules()).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  test("skips schedules and tasks already present in Nexus", async () => {
    const localTask = fakeTask();
    const localSchedule = fakeSchedule();
    const report = await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore([localTask]),
      localScheduleStore: createScheduleStore([localSchedule]),
      nexusTaskStore: createTaskStore([localTask]),
      nexusScheduleStore: createScheduleStore([localSchedule]),
      nexusQueueBackend: createQueueBackend().queue,
    });

    expect(report).toEqual<SchedulerMigrationReport>({
      schedulesImported: 0,
      tasksImported: 0,
      skippedExistingSchedules: 1,
      skippedExistingTasks: 1,
    });
  });

  test("requeues interrupted running tasks with a consumed retry", async () => {
    const runningTask = fakeTask({ status: "running", retries: 1, maxRetries: 3 });
    const { queue, enqueued } = createQueueBackend();
    const nexusTaskStore = createTaskStore();

    const report = await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore([runningTask]),
      localScheduleStore: createScheduleStore(),
      nexusTaskStore,
      nexusScheduleStore: createScheduleStore(),
      nexusQueueBackend: queue,
    });

    expect(report).toEqual<SchedulerMigrationReport>({
      schedulesImported: 0,
      tasksImported: 1,
      skippedExistingSchedules: 0,
      skippedExistingTasks: 0,
    });
    expect(await nexusTaskStore.load(runningTask.id)).toEqual({
      ...runningTask,
      status: "pending",
      retries: 2,
    });
    expect(enqueued).toEqual([
      {
        ...runningTask,
        status: "pending",
        retries: 2,
      },
    ]);
  });

  test("dead-letters exhausted running tasks instead of requeueing them", async () => {
    const exhaustedTask = fakeTask({ status: "running", retries: 3, maxRetries: 3 });
    const { queue, enqueued } = createQueueBackend();
    const nexusTaskStore = createTaskStore();

    await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore([exhaustedTask]),
      localScheduleStore: createScheduleStore(),
      nexusTaskStore,
      nexusScheduleStore: createScheduleStore(),
      nexusQueueBackend: queue,
    });

    expect(await nexusTaskStore.load(exhaustedTask.id)).toEqual({
      ...exhaustedTask,
      status: "dead_letter",
    });
    expect(enqueued).toEqual([]);
  });

  test("empty local stores produce a zero report and no Nexus reads", async () => {
    const inner = createScheduleStore();
    const loadSchedulesSpy = mock(() => inner.loadSchedules());
    const nexusScheduleStore: ScheduleStore = {
      saveSchedule: inner.saveSchedule.bind(inner),
      removeSchedule: inner.removeSchedule.bind(inner),
      loadSchedules: loadSchedulesSpy,
      [Symbol.asyncDispose]: inner[Symbol.asyncDispose].bind(inner),
    };
    const { queue, enqueued } = createQueueBackend();

    const report = await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore(),
      localScheduleStore: createScheduleStore(),
      nexusTaskStore: createTaskStore(),
      nexusScheduleStore,
      nexusQueueBackend: queue,
    });

    expect(report).toEqual<SchedulerMigrationReport>({
      schedulesImported: 0,
      tasksImported: 0,
      skippedExistingSchedules: 0,
      skippedExistingTasks: 0,
    });
    // Short-circuit: when both local sides are empty, the migration must
    // not even read the existing nexus schedules (avoids needless RPCs).
    expect(loadSchedulesSpy).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });

  test("running task with maxRetries=0 dead-letters immediately", async () => {
    const noRetryTask = fakeTask({ status: "running", retries: 0, maxRetries: 0 });
    const { queue, enqueued } = createQueueBackend();
    const nexusTaskStore = createTaskStore();

    await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore([noRetryTask]),
      localScheduleStore: createScheduleStore(),
      nexusTaskStore,
      nexusScheduleStore: createScheduleStore(),
      nexusQueueBackend: queue,
    });

    expect((await nexusTaskStore.load(noRetryTask.id))?.status).toBe("dead_letter");
    expect(enqueued).toEqual([]);
  });

  test("mixed batch: imports new, skips existing, dead-letters exhausted", async () => {
    const newPending = fakeTask({ id: "task-new" as ScheduledTask["id"] });
    const dupPending = fakeTask({ id: "task-dup" as ScheduledTask["id"] });
    const runningRetry = fakeTask({
      id: "task-run" as ScheduledTask["id"],
      status: "running",
      retries: 0,
      maxRetries: 2,
    });
    const exhausted = fakeTask({
      id: "task-dead" as ScheduledTask["id"],
      status: "running",
      retries: 5,
      maxRetries: 5,
    });
    const newSched = fakeSchedule({ id: "sched-new" as CronSchedule["id"] });
    const dupSched = fakeSchedule({ id: "sched-dup" as CronSchedule["id"] });

    const { queue, enqueued } = createQueueBackend();
    const nexusTaskStore = createTaskStore([dupPending]);
    const nexusScheduleStore = createScheduleStore([dupSched]);

    const report = await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore([newPending, dupPending, runningRetry, exhausted]),
      localScheduleStore: createScheduleStore([newSched, dupSched]),
      nexusTaskStore,
      nexusScheduleStore,
      nexusQueueBackend: queue,
    });

    expect(report).toEqual<SchedulerMigrationReport>({
      schedulesImported: 1,
      tasksImported: 3,
      skippedExistingSchedules: 1,
      skippedExistingTasks: 1,
    });
    // Only pending-status migrated tasks are enqueued (newPending + requeued running).
    expect(enqueued.map((t) => t.id as string).sort()).toEqual(["task-new", "task-run"]);
    expect((await nexusTaskStore.load("task-dead" as ScheduledTask["id"]))?.status).toBe(
      "dead_letter",
    );
  });

  test("is idempotent: second run is a full no-op import-wise", async () => {
    const localTask = fakeTask();
    const localSchedule = fakeSchedule();
    const localTaskStore = createTaskStore([localTask]);
    const localScheduleStore = createScheduleStore([localSchedule]);
    const nexusTaskStore = createTaskStore();
    const nexusScheduleStore = createScheduleStore();
    const { queue, enqueued } = createQueueBackend();

    const first = await migrateLocalSchedulerToNexus({
      localTaskStore,
      localScheduleStore,
      nexusTaskStore,
      nexusScheduleStore,
      nexusQueueBackend: queue,
    });
    const second = await migrateLocalSchedulerToNexus({
      localTaskStore,
      localScheduleStore,
      nexusTaskStore,
      nexusScheduleStore,
      nexusQueueBackend: queue,
    });

    expect(first).toEqual<SchedulerMigrationReport>({
      schedulesImported: 1,
      tasksImported: 1,
      skippedExistingSchedules: 0,
      skippedExistingTasks: 0,
    });
    expect(second).toEqual<SchedulerMigrationReport>({
      schedulesImported: 0,
      tasksImported: 0,
      skippedExistingSchedules: 1,
      skippedExistingTasks: 1,
    });
    // Crucially: the queue must NOT be re-enqueued on the second pass.
    expect(enqueued).toHaveLength(1);
  });

  test("preserves existing Nexus schedule content when skipping (no overwrite)", async () => {
    const localSched = fakeSchedule({ expression: "*/1 * * * *", paused: false });
    const nexusSched = fakeSchedule({ expression: "0 0 * * *", paused: true });
    const nexusScheduleStore = createScheduleStore([nexusSched]);

    await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore(),
      localScheduleStore: createScheduleStore([localSched]),
      nexusTaskStore: createTaskStore(),
      nexusScheduleStore,
      nexusQueueBackend: createQueueBackend().queue,
    });

    const stored = (await nexusScheduleStore.loadSchedules())[0];
    expect(stored?.expression).toBe("0 0 * * *");
    expect(stored?.paused).toBe(true);
  });

  test("loadPending is the source of truth — completed tasks are ignored", async () => {
    // The local store contains a completed task; loadPending() filters to
    // pending+running only. Migration must not import the completed task.
    const completed = fakeTask({
      id: "task-done" as ScheduledTask["id"],
      status: "completed",
    });
    const pending = fakeTask({ id: "task-pending" as ScheduledTask["id"] });
    const nexusTaskStore = createTaskStore();
    const { queue, enqueued } = createQueueBackend();

    const report = await migrateLocalSchedulerToNexus({
      localTaskStore: createTaskStore([completed, pending]),
      localScheduleStore: createScheduleStore(),
      nexusTaskStore,
      nexusScheduleStore: createScheduleStore(),
      nexusQueueBackend: queue,
    });

    expect(report.tasksImported).toBe(1);
    expect(await nexusTaskStore.load("task-done" as ScheduledTask["id"])).toBeUndefined();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.id as string).toBe("task-pending");
  });
});

import type {
  CronSchedule,
  ScheduledTask,
  ScheduleStore,
  TaskQueueBackend,
  TaskStore,
} from "@koi/core";

export interface SchedulerMigrationReport {
  readonly schedulesImported: number;
  readonly tasksImported: number;
  readonly skippedExistingSchedules: number;
  readonly skippedExistingTasks: number;
}

export interface SchedulerMigrationArgs {
  readonly localTaskStore: TaskStore;
  readonly localScheduleStore: ScheduleStore;
  readonly nexusTaskStore: TaskStore;
  readonly nexusScheduleStore: ScheduleStore;
  readonly nexusQueueBackend: TaskQueueBackend;
}

function repairForMigration(task: ScheduledTask): ScheduledTask {
  if (task.status !== "running") return task;
  if (task.retries < task.maxRetries) {
    return { ...task, status: "pending" as const, retries: task.retries + 1 };
  }
  return { ...task, status: "dead_letter" as const };
}

async function importSchedules(
  locals: readonly CronSchedule[],
  store: ScheduleStore,
): Promise<{ readonly imported: number; readonly skipped: number }> {
  const existing = new Set((await store.loadSchedules()).map((s) => s.id));
  let imported = 0;
  let skipped = 0;
  for (const schedule of locals) {
    if (existing.has(schedule.id)) {
      skipped += 1;
      continue;
    }
    await store.saveSchedule(schedule);
    imported += 1;
  }
  return { imported, skipped };
}

async function importTasks(
  locals: readonly ScheduledTask[],
  taskStore: TaskStore,
  queue: TaskQueueBackend,
): Promise<{ readonly imported: number; readonly skipped: number }> {
  let imported = 0;
  let skipped = 0;
  for (const task of locals) {
    if ((await taskStore.load(task.id)) !== undefined) {
      skipped += 1;
      continue;
    }
    const migrated = repairForMigration(task);
    await taskStore.save(migrated);
    if (migrated.status === "pending") await queue.enqueue(migrated, task.id);
    imported += 1;
  }
  return { imported, skipped };
}

export async function migrateLocalSchedulerToNexus(
  args: SchedulerMigrationArgs,
): Promise<SchedulerMigrationReport> {
  const localSchedules = await args.localScheduleStore.loadSchedules();
  const localTasks = await args.localTaskStore.loadPending();

  if (localSchedules.length === 0 && localTasks.length === 0) {
    return {
      schedulesImported: 0,
      tasksImported: 0,
      skippedExistingSchedules: 0,
      skippedExistingTasks: 0,
    };
  }

  const schedules = await importSchedules(localSchedules, args.nexusScheduleStore);
  const tasks = await importTasks(localTasks, args.nexusTaskStore, args.nexusQueueBackend);

  return {
    schedulesImported: schedules.imported,
    tasksImported: tasks.imported,
    skippedExistingSchedules: schedules.skipped,
    skippedExistingTasks: tasks.skipped,
  };
}

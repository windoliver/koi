import type { ScheduleStore, TaskQueueBackend, TaskStore } from "@koi/core";

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

  let schedulesImported = 0;
  let tasksImported = 0;
  let skippedExistingSchedules = 0;
  let skippedExistingTasks = 0;

  const existingSchedules = new Set(
    (await args.nexusScheduleStore.loadSchedules()).map((schedule) => schedule.id),
  );

  for (const schedule of localSchedules) {
    if (existingSchedules.has(schedule.id)) {
      skippedExistingSchedules += 1;
      continue;
    }
    await args.nexusScheduleStore.saveSchedule(schedule);
    schedulesImported += 1;
  }

  for (const task of localTasks) {
    const existingTask = await args.nexusTaskStore.load(task.id);
    if (existingTask !== undefined) {
      skippedExistingTasks += 1;
      continue;
    }
    const migratedTask =
      task.status === "running"
        ? task.retries < task.maxRetries
          ? {
              ...task,
              status: "pending" as const,
              retries: task.retries + 1,
            }
          : {
              ...task,
              status: "dead_letter" as const,
            }
        : task;
    await args.nexusTaskStore.save(migratedTask);
    if (migratedTask.status === "pending") {
      await args.nexusQueueBackend.enqueue(migratedTask, task.id);
    }
    tasksImported += 1;
  }

  return {
    schedulesImported,
    tasksImported,
    skippedExistingSchedules,
    skippedExistingTasks,
  };
}

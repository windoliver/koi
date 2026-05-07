import type { CronSchedule, KoiError, Result, ScheduleStore } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

interface ApiSchedule {
  readonly id: string;
  readonly expression: string;
  readonly agent_id: string;
  readonly input: unknown;
  readonly mode: string;
  readonly task_options?: unknown | undefined;
  readonly timezone?: string | undefined;
  readonly paused: boolean;
}

interface ApiListResponse {
  readonly schedules: readonly ApiSchedule[];
}

export function createNexusScheduleStore(transport: NexusTransport): ScheduleStore {
  return {
    async saveSchedule(schedule: CronSchedule): Promise<void> {
      unwrap(await transport.call("scheduler.schedule.save", scheduleToWire(schedule)));
    },

    async removeSchedule(id: CronSchedule["id"]): Promise<void> {
      unwrap(await transport.call("scheduler.schedule.remove", { id }));
    },

    async loadSchedules(): Promise<readonly CronSchedule[]> {
      const result = unwrap<ApiListResponse>(await transport.call("scheduler.schedule.list", {}));
      return result.schedules.map(mapApiSchedule);
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      transport.close();
    },
  };
}

function mapApiSchedule(schedule: ApiSchedule): CronSchedule {
  return {
    id: schedule.id as CronSchedule["id"],
    expression: schedule.expression,
    agentId: schedule.agent_id as CronSchedule["agentId"],
    input: schedule.input as CronSchedule["input"],
    mode: schedule.mode as CronSchedule["mode"],
    taskOptions: schedule.task_options as CronSchedule["taskOptions"],
    timezone: schedule.timezone,
    paused: schedule.paused,
  };
}

function scheduleToWire(schedule: CronSchedule): Record<string, unknown> {
  return {
    id: schedule.id,
    expression: schedule.expression,
    agent_id: schedule.agentId,
    input: schedule.input,
    mode: schedule.mode,
    task_options: schedule.taskOptions,
    timezone: schedule.timezone,
    paused: schedule.paused,
  };
}

function unwrap<T>(result: Result<T, KoiError>): T {
  if (!result.ok) {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value;
}

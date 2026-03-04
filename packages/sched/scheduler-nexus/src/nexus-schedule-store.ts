/**
 * Nexus-backed ScheduleStore implementation via JSON-RPC.
 *
 * Delegates cron schedule persistence to a remote Nexus server,
 * enabling distributed schedule management across nodes.
 */

import type { CronSchedule, ScheduleId, ScheduleStore } from "@koi/core";
import { scheduleId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";

// ---------------------------------------------------------------------------
// Wire types (snake_case from Nexus)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Wire → domain mapping
// ---------------------------------------------------------------------------

function mapApiSchedule(wire: ApiSchedule): CronSchedule {
  return {
    id: scheduleId(wire.id),
    expression: wire.expression,
    agentId: wire.agent_id as CronSchedule["agentId"],
    input: wire.input as CronSchedule["input"],
    mode: wire.mode as CronSchedule["mode"],
    taskOptions: wire.task_options as CronSchedule["taskOptions"],
    timezone: wire.timezone,
    paused: wire.paused,
  };
}

/** Serialize a CronSchedule to snake_case wire format. */
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

// ---------------------------------------------------------------------------
// RPC result unwrapper
// ---------------------------------------------------------------------------

function unwrap<T>(result: {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
}): T {
  if (!result.ok) {
    const err = result.error as { readonly message?: string } | undefined;
    throw new Error(err?.message ?? "Nexus RPC failed", { cause: result.error });
  }
  return (result as { readonly value: T }).value;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed ScheduleStore using JSON-RPC. */
export function createNexusScheduleStore(client: NexusClient): ScheduleStore {
  return {
    async saveSchedule(schedule: CronSchedule): Promise<void> {
      unwrap(await client.rpc("scheduler.schedule.save", scheduleToWire(schedule)));
    },

    async removeSchedule(id: ScheduleId): Promise<void> {
      unwrap(await client.rpc("scheduler.schedule.remove", { id }));
    },

    async loadSchedules(): Promise<readonly CronSchedule[]> {
      const result = unwrap<ApiListResponse>(await client.rpc("scheduler.schedule.list", {}));
      return result.schedules.map(mapApiSchedule);
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      // No persistent connections to clean up
    },
  };
}

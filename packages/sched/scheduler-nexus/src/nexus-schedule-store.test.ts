import { describe, expect, test } from "bun:test";
import type { CronSchedule, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusScheduleStore } from "./nexus-schedule-store.js";

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function agentId(id: string): CronSchedule["agentId"] {
  return id as CronSchedule["agentId"];
}

function scheduleId(id: string): CronSchedule["id"] {
  return id as CronSchedule["id"];
}

const sampleSchedule: CronSchedule = {
  id: scheduleId("schedule-1"),
  expression: "0 * * * *",
  agentId: agentId("agent-1"),
  input: { kind: "text", text: "hello" },
  mode: "spawn",
  paused: false,
  timezone: "UTC",
  taskOptions: { priority: 1, maxRetries: 2 },
};

describe("createNexusScheduleStore", () => {
  test("saveSchedule sends snake_case payload", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const store = createNexusScheduleStore({
      call: async <T>(method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return ok(undefined as T);
      },
      close: () => {},
    } satisfies NexusTransport);

    await store.saveSchedule(sampleSchedule);

    expect(calls[0]?.method).toBe("scheduler.schedule.save");
    expect(calls[0]?.params.agent_id).toBe("agent-1");
    expect(calls[0]?.params.task_options).toEqual({ priority: 1, maxRetries: 2 });
  });

  test("loadSchedules maps wire schedules", async () => {
    const store = createNexusScheduleStore({
      call: async <T>() =>
        ok({
          schedules: [
            {
              id: "schedule-2",
              expression: "*/5 * * * *",
              agent_id: "agent-2",
              input: { kind: "text", text: "loaded" },
              mode: "dispatch",
              timezone: "America/Los_Angeles",
              paused: true,
            },
          ],
        } as T),
      close: () => {},
    } satisfies NexusTransport);

    const schedules = await store.loadSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.id).toBe(scheduleId("schedule-2"));
    expect(schedules[0]?.paused).toBe(true);
    expect(schedules[0]?.timezone).toBe("America/Los_Angeles");
  });
});

import type { ScheduleId, SchedulerComponent, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, scheduleId } from "@koi/core";

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_unschedule",
  description: "Remove a cron schedule. Only your own schedules can be removed.",
  inputSchema: {
    type: "object",
    properties: { scheduleId: { type: "string" } },
    required: ["scheduleId"],
  },
};

export function createUnscheduleTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const id = scheduleId(String(args.scheduleId) as ScheduleId);
      const removed = await component.unschedule(id);
      return { removed };
    },
  };
}

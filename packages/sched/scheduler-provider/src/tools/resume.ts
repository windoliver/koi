import type { ScheduleId, SchedulerComponent, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, scheduleId } from "@koi/core";

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_resume",
  description: "Resume a paused cron schedule.",
  inputSchema: {
    type: "object",
    properties: { scheduleId: { type: "string" } },
    required: ["scheduleId"],
  },
};

export function createResumeTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const id = scheduleId(String(args.scheduleId) as ScheduleId);
      const resumed = await component.resume(id);
      return { resumed };
    },
  };
}

import type { SchedulerComponent, TaskId, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, taskId } from "@koi/core";

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_cancel",
  description: "Cancel a pending task. Only your own tasks can be cancelled.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task ID to cancel." },
    },
    required: ["taskId"],
  },
};

export function createCancelTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const id = taskId(String(args.taskId) as TaskId);
      const cancelled = await component.cancel(id);
      return { cancelled };
    },
  };
}

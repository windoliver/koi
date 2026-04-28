import type { ScheduledTaskStatus, SchedulerComponent, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_query",
  description: "List your tasks. Filtered to your own tasks only.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "running", "completed", "failed", "dead_letter"],
      },
      priority: { type: "number" },
      limit: { type: "number", description: `Max ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
    },
  },
};

export function createQueryTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const limit = Math.min(
        args.limit !== undefined ? Number(args.limit) : DEFAULT_LIMIT,
        MAX_LIMIT,
      );
      const tasks = await component.query({
        status:
          args.status !== undefined ? (String(args.status) as ScheduledTaskStatus) : undefined,
        priority: args.priority !== undefined ? Number(args.priority) : undefined,
        limit,
      });
      return { tasks, count: tasks.length };
    },
  };
}

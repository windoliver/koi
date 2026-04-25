import type { SchedulerComponent, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_stats",
  description: "Get task and schedule counts scoped to your agent.",
  inputSchema: { type: "object", properties: {} },
};

export function createStatsTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (_args) => {
      const stats = await component.stats();
      return stats;
    },
  };
}

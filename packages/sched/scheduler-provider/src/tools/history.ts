import type { SchedulerComponent, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_history",
  description: "View execution history for your tasks.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "failed"] },
      since: { type: "number", description: "Unix timestamp ms — only runs after this time." },
      limit: { type: "number", description: `Max ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
    },
  },
};

export function createHistoryTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const limit = Math.min(
        args.limit !== undefined ? Number(args.limit) : DEFAULT_LIMIT,
        MAX_LIMIT,
      );
      const runs = await component.history({
        status:
          args.status !== undefined ? (String(args.status) as "completed" | "failed") : undefined,
        since: args.since !== undefined ? Number(args.since) : undefined,
        limit,
      });
      return { runs, count: runs.length };
    },
  };
}

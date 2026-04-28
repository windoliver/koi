import type { EngineInput, SchedulerComponent, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_schedule",
  description: "Create a recurring cron schedule.",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: 'Cron expression, e.g. "0 9 * * 1-5".' },
      input: { type: "string", description: "Text input dispatched on each tick." },
      mode: { type: "string", enum: ["spawn", "dispatch"] },
      timezone: { type: "string", description: 'IANA timezone, e.g. "America/New_York".' },
      priority: { type: "number" },
      maxRetries: { type: "number" },
      timeoutMs: { type: "number" },
    },
    required: ["expression", "input", "mode"],
  },
};

export function createScheduleTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const expression = String(args.expression);
      const input: EngineInput = { kind: "text", text: String(args.input) };
      const mode = String(args.mode) as "spawn" | "dispatch";
      const scheduleId = await component.schedule(expression, input, mode, {
        timezone: args.timezone !== undefined ? String(args.timezone) : undefined,
        priority: args.priority !== undefined ? Number(args.priority) : undefined,
        maxRetries: args.maxRetries !== undefined ? Number(args.maxRetries) : undefined,
        timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
      });
      return { scheduleId };
    },
  };
}

import type { EngineInput, SchedulerComponent, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

const DESCRIPTOR: ToolDescriptor = {
  name: "scheduler_submit",
  description: "Submit a one-off task for immediate or delayed execution.",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Text input for the task." },
      mode: { type: "string", enum: ["spawn", "dispatch"], description: "Execution mode." },
      priority: { type: "number", description: "Priority 0 (highest) to 10. Default: 5." },
      delayMs: { type: "number", description: "Delay in milliseconds before execution." },
      maxRetries: { type: "number", description: "Max retry attempts. Default: 3." },
      timeoutMs: {
        type: "number",
        description: "Timeout in ms. Timed-out tasks are dead-lettered.",
      },
    },
    required: ["input", "mode"],
  },
};

export function createSubmitTool(component: SchedulerComponent): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const input: EngineInput = { kind: "text", text: String(args.input) };
      const mode = String(args.mode) as "spawn" | "dispatch";
      const taskId = await component.submit(input, mode, {
        priority: args.priority !== undefined ? Number(args.priority) : undefined,
        delayMs: args.delayMs !== undefined ? Number(args.delayMs) : undefined,
        maxRetries: args.maxRetries !== undefined ? Number(args.maxRetries) : undefined,
        timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
      });
      return { taskId };
    },
  };
}

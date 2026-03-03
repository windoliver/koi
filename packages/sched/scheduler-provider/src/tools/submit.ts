/**
 * Tool factory for `scheduler_submit` — submit a one-shot task.
 */

import type { JsonObject, SchedulerComponent, TaskOptions, Tool, TrustTier } from "@koi/core";
import { parseEnum, parseOptionalNumber, parseOptionalString } from "../parse-args.js";

export function createSubmitTool(
  component: SchedulerComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_submit`,
      description: "Submit a one-shot task for execution by this agent.",
      inputSchema: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Task input (text prompt or JSON-encoded EngineInput)",
          },
          mode: {
            type: "string",
            enum: ["spawn", "dispatch"],
            description: "Execution mode: spawn (new agent) or dispatch (reuse current)",
          },
          priority: {
            type: "number",
            description: "Priority level (0 = highest). Default: 5",
          },
          delayMs: {
            type: "number",
            description: "Defer execution by this many milliseconds",
          },
          maxRetries: {
            type: "number",
            description: "Maximum retry attempts. Default: 3",
          },
          timeoutMs: {
            type: "number",
            description: "Per-execution timeout in milliseconds",
          },
        },
        required: ["input", "mode"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const inputResult = parseOptionalString(args, "input");
      if (!inputResult.ok) return inputResult.err;

      const modeResult = parseEnum(args, "mode", ["spawn", "dispatch"] as const);
      if (!modeResult.ok) return modeResult.err;

      const priorityResult = parseOptionalNumber(args, "priority");
      if (!priorityResult.ok) return priorityResult.err;

      const delayMsResult = parseOptionalNumber(args, "delayMs");
      if (!delayMsResult.ok) return delayMsResult.err;

      const maxRetriesResult = parseOptionalNumber(args, "maxRetries");
      if (!maxRetriesResult.ok) return maxRetriesResult.err;

      const timeoutMsResult = parseOptionalNumber(args, "timeoutMs");
      if (!timeoutMsResult.ok) return timeoutMsResult.err;

      const engineInput = { kind: "text" as const, text: inputResult.value ?? "" };

      const options: TaskOptions = {
        ...(priorityResult.value !== undefined && { priority: priorityResult.value }),
        ...(delayMsResult.value !== undefined && { delayMs: delayMsResult.value }),
        ...(maxRetriesResult.value !== undefined && { maxRetries: maxRetriesResult.value }),
        ...(timeoutMsResult.value !== undefined && { timeoutMs: timeoutMsResult.value }),
      };

      try {
        const id = await component.submit(engineInput, modeResult.value, options);
        return { taskId: id };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}

/**
 * Tool factory for `scheduler_schedule` — create a recurring cron schedule.
 */

import type {
  EngineInput,
  JsonObject,
  SchedulerComponent,
  TaskOptions,
  Tool,
  ToolPolicy,
} from "@koi/core";
import { parseEnum, parseOptionalNumber, parseOptionalString, parseString } from "../parse-args.js";
import { parseEngineInput } from "../parse-engine-input.js";

export function createScheduleTool(
  component: SchedulerComponent,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_schedule`,
      description: "Create a recurring cron schedule for this agent.",
      inputSchema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: 'Cron expression (e.g., "0 0 * * *" for daily at midnight)',
          },
          input: {
            type: "string",
            description: "Task input (text prompt or JSON-encoded EngineInput)",
          },
          mode: {
            type: "string",
            enum: ["spawn", "dispatch"],
            description: "Execution mode: spawn (new agent) or dispatch (reuse current)",
          },
          timezone: {
            type: "string",
            description: 'IANA timezone (e.g., "America/New_York"). Default: UTC',
          },
          priority: {
            type: "number",
            description: "Priority level (0 = highest). Default: 5",
          },
        },
        required: ["expression", "input", "mode"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const expressionResult = parseString(args, "expression");
      if (!expressionResult.ok) return expressionResult.err;

      const inputResult = parseString(args, "input");
      if (!inputResult.ok) return inputResult.err;

      const modeResult = parseEnum(args, "mode", ["spawn", "dispatch"] as const);
      if (!modeResult.ok) return modeResult.err;

      const timezoneResult = parseOptionalString(args, "timezone");
      if (!timezoneResult.ok) return timezoneResult.err;

      const priorityResult = parseOptionalNumber(args, "priority");
      if (!priorityResult.ok) return priorityResult.err;

      const engineInput: EngineInput = parseEngineInput(inputResult.value);

      const options: TaskOptions & { readonly timezone?: string | undefined } = {
        ...(priorityResult.value !== undefined && { priority: priorityResult.value }),
        ...(timezoneResult.value !== undefined && { timezone: timezoneResult.value }),
      };

      try {
        const id = await component.schedule(
          expressionResult.value,
          engineInput,
          modeResult.value,
          options,
        );
        return { scheduleId: id };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}

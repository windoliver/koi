/**
 * Tool factory for `scheduler_cancel` — cancel a scheduled task.
 */

import type { JsonObject, SchedulerComponent, Tool, ToolPolicy } from "@koi/core";
import { taskId } from "@koi/core";
import { parseString } from "../parse-args.js";

export function createCancelTool(
  component: SchedulerComponent,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_cancel`,
      description: "Cancel a pending or running task by its ID.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task ID to cancel" },
        },
        required: ["taskId"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const idResult = parseString(args, "taskId");
      if (!idResult.ok) return idResult.err;

      try {
        const cancelled = await component.cancel(taskId(idResult.value));
        return { cancelled };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}

import type { JsonObject, ManagedTaskBoard, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the task to retrieve"),
});

export function createTaskGetTool(board: ManagedTaskBoard): Tool {
  return {
    descriptor: {
      name: "task_get",
      description:
        "Retrieve full details for a specific task by ID, including metadata and timestamps. " +
        "Use task_list to find task IDs.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const id = taskItemId(parsed.data.task_id);
      const task = board.snapshot().get(id);
      if (task === undefined) {
        return { ok: false, error: `Task not found: ${parsed.data.task_id}` };
      }

      return { ok: true, task };
    },
  };
}

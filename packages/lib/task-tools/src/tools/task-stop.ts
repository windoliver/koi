import type { JsonObject, ManagedTaskBoard, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, isTerminalTaskStatus, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the in-progress task to stop"),
  reason: z.string().optional().describe("Optional reason for stopping the task"),
});

export function createTaskStopTool(board: ManagedTaskBoard): Tool {
  return {
    descriptor: {
      name: "task_stop",
      description:
        "Stop (kill) a currently in-progress task. " +
        "Returns an error if the task is not in_progress (pending tasks do not need stopping — just don't start them). " +
        "Downstream tasks that depend on this task will become unreachable.",
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

      const { task_id, reason } = parsed.data;
      const id = taskItemId(task_id);
      const task = board.snapshot().get(id);

      if (task === undefined) {
        return { ok: false, error: `Task not found: ${task_id}` };
      }

      if (isTerminalTaskStatus(task.status)) {
        return {
          ok: false,
          error: `Cannot stop task '${task_id}': already in terminal state '${task.status}'`,
        };
      }

      // Decision 4A: task_stop targets in_progress only
      if (task.status !== "in_progress") {
        return {
          ok: false,
          error:
            `Cannot stop task '${task_id}': status is '${task.status}', expected 'in_progress'. ` +
            "Pending tasks do not need to be stopped.",
        };
      }

      const result = await board.kill(id);
      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }

      return {
        ok: true,
        taskId: id,
        message: reason !== undefined ? `Task stopped: ${reason}` : "Task stopped.",
      };
    },
  };
}

import type { AgentId, JsonObject, ManagedTaskBoard, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";
import type { TaskOutputResponse } from "../types.js";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the task to retrieve output for"),
});

export function createTaskOutputTool(board: ManagedTaskBoard, agentId: AgentId): Tool {
  return {
    descriptor: {
      name: "task_output",
      description:
        "Retrieve the output or current status of a task. " +
        "Returns full TaskResult for completed tasks, status info for pending/in_progress tasks, " +
        "and error details for failed/killed tasks.",
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
      const snapshot = board.snapshot();
      const task = snapshot.get(id);

      if (task === undefined) {
        const response: TaskOutputResponse = { kind: "not_found", taskId: id };
        return response;
      }

      // Read authorization: reject cross-agent reads when assignedTo is explicitly
      // set to a different agent. If assignedTo is undefined (pending, or cleared
      // on failure/retry), allow the read — we cannot determine the prior owner.
      if (task.assignedTo !== undefined && task.assignedTo !== agentId) {
        return {
          ok: false,
          error: `Cannot read task '${parsed.data.task_id}': it is assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
        };
      }

      // Exhaustive switch — TS enforces all TaskStatus cases are handled
      switch (task.status) {
        case "pending": {
          const response: TaskOutputResponse = {
            kind: "pending",
            task: toTaskSummary(task, snapshot),
          };
          return response;
        }
        case "in_progress": {
          const response: TaskOutputResponse = {
            kind: "in_progress",
            task: toTaskSummary(task, snapshot),
          };
          return response;
        }
        case "completed": {
          const result = snapshot.result(id);
          if (result === undefined) {
            // Decision 16B: completed but result not persisted (no resultsDir)
            const response: TaskOutputResponse = {
              kind: "completed_no_result",
              taskId: id,
              message:
                "Task completed but output was not persisted. " +
                "Configure resultsDir in ManagedTaskBoardConfig to retain results across restarts.",
            };
            return response;
          }
          const response: TaskOutputResponse = { kind: "completed", result };
          return response;
        }
        case "failed": {
          const response: TaskOutputResponse = {
            kind: "failed",
            task,
            error: task.error ?? {
              code: "EXTERNAL",
              message: "Task failed with no error details",
              retryable: false,
            },
          };
          return response;
        }
        case "killed": {
          const response: TaskOutputResponse = { kind: "killed", task };
          return response;
        }
      }
    },
  };
}

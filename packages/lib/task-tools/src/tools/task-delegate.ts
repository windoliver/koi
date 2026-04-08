import type { JsonObject, ManagedTaskBoard, TaskItemId, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the pending task to delegate"),
  agent_id: z.string().min(1).describe("ID of the child agent that will execute this task"),
});

/**
 * task_delegate — coordinator delegation tool.
 *
 * Records delegation intent in metadata only — does NOT change task status or
 * assignedTo. The task stays `pending` with no `assignedTo`.
 *
 * Design rationale: assigning the coordinator's AgentId as owner breaks the
 * worker/recovery contract. task_update, task_output, and orphan recovery all
 * use assignedTo as source of truth for ownership. Workers can't close tasks
 * they don't own; orphan recovery can't identify stale delegated work.
 *
 * This pure-metadata approach keeps the task available for the worker to claim
 * via task_update(status: in_progress) once spawned, and allows recovery to
 * detect stale pending+delegatedTo tasks normally.
 *
 * Rejection cases:
 *   - Task not found
 *   - Task is not pending (already in_progress/completed/etc.)
 *   - Task already has metadata.delegatedTo set
 */
export function createTaskDelegateTool(board: ManagedTaskBoard): Tool {
  return {
    descriptor: {
      name: "task_delegate",
      description:
        "Delegate a pending task to a named child agent. " +
        "Records the intended executor in metadata.delegatedTo only — " +
        "the task remains pending with no assignedTo change. " +
        "The spawned worker claims the task via task_update(status: in_progress).",
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

      const { task_id, agent_id } = parsed.data;
      const id = taskItemId(task_id);
      const snapshot = board.snapshot();
      const task = snapshot.get(id);

      if (task === undefined) {
        return { ok: false, error: `Task not found: ${task_id}` };
      }
      if (task.status !== "pending") {
        return {
          ok: false,
          error:
            `Cannot delegate task '${task_id}': status is '${task.status}'. ` +
            "Only pending tasks may be delegated.",
        };
      }
      if (task.metadata?.delegatedTo !== undefined) {
        return {
          ok: false,
          error:
            `Task '${task_id}' is already delegated to '${String(task.metadata.delegatedTo)}'. ` +
            "Undelegate first or create a new task.",
        };
      }

      // Record intended executor in metadata only. Preserve any existing metadata.
      // The task stays pending — no status change, no assignedTo assignment.
      const existingMeta = task.metadata ?? {};
      const metaResult = await board.update(id, {
        metadata: { ...existingMeta, delegatedTo: agent_id },
      });
      if (!metaResult.ok) {
        return { ok: false, error: metaResult.error.message };
      }

      const updatedTask = board.snapshot().get(id);
      return {
        ok: true,
        task:
          updatedTask !== undefined
            ? toTaskSummary(updatedTask, board.snapshot())
            : ({ id } satisfies { id: TaskItemId }),
        delegatedTo: agent_id,
      };
    },
  };
}

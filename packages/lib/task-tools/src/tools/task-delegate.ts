import type { AgentId, JsonObject, ManagedTaskBoard, TaskItemId, Tool } from "@koi/core";
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
 * Atomically assigns a pending task to the calling coordinator's AgentId
 * (making it in_progress so it can't be re-dispatched) and records the
 * intended child agent name in `metadata.delegatedTo`.
 *
 * The coordinator retains board ownership (assignedTo = coordinatorAgentId)
 * so it can complete or fail the task after agent_spawn returns.
 *
 * Design: task_delegate and agent_spawn are independent tools. The coordinator
 * manually closes the loop: delegate → spawn → read output → task_update.
 * For autonomous mode (#1553), a bridge (like v1's dispatchSpawnTasks) will
 * atomically couple delegate → spawn → auto-complete.
 *
 * Rejection cases:
 *   - Task not found
 *   - Task is not pending (already in_progress/completed/etc.)
 *   - Task already has metadata.delegatedTo set
 */
export function createTaskDelegateTool(board: ManagedTaskBoard, coordinatorAgentId: AgentId): Tool {
  return {
    descriptor: {
      name: "task_delegate",
      description:
        "Delegate a pending task to a named child agent. " +
        "Moves the task to in_progress (preventing re-dispatch) and records the " +
        "intended executor in metadata.delegatedTo. The coordinator retains " +
        "board ownership and must complete or fail the task after agent_spawn returns.",
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

      // Atomically claim the task as coordinator-owned in_progress.
      // board.assign() is serialized inside the managed-board lock — prevents
      // concurrent delegates from both succeeding on the same pending task.
      const assignResult = await board.assign(id, coordinatorAgentId);
      if (!assignResult.ok) {
        return { ok: false, error: assignResult.error.message };
      }

      // Record intended executor in metadata. Preserve any existing metadata.
      // updateOwned is atomic within the lock and verifies we still own the task.
      // If updateOwned fails, compensate by unassigning so the task returns to
      // pending — prevents the task being stuck in_progress with no delegatedTo.
      const existingMeta = board.snapshot().get(id)?.metadata ?? {};
      let metaResult: Awaited<ReturnType<typeof board.updateOwned>>;
      try {
        metaResult = await board.updateOwned(id, coordinatorAgentId, {
          metadata: { ...existingMeta, delegatedTo: agent_id },
        });
      } catch (e: unknown) {
        // Best-effort rollback: if unassign also fails, the board is in a bad
        // state, but we still surface the original error to the caller.
        await board.unassign(id).catch(() => undefined);
        throw e;
      }
      if (!metaResult.ok) {
        // Compensating rollback: reset task to pending so it can be re-delegated.
        await board.unassign(id).catch(() => undefined);
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

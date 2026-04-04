import type { AgentId, JsonObject, ManagedTaskBoard, TaskItemId, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, agentId as mkAgentId, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the pending task to delegate"),
  agent_id: z.string().min(1).describe("ID of the child agent that will execute this task"),
});

/**
 * task_delegate — coordinator delegation tool.
 *
 * Assigns a pending task to a child agent without triggering the
 * single-in-progress guard enforced by task_update. Coordinators use this
 * to fan-out N tasks simultaneously; workers use task_update for claiming
 * their own single in-progress task.
 *
 * Only pending tasks may be delegated. In-progress (already delegated),
 * completed, failed, and killed tasks are rejected.
 */
export function createTaskDelegateTool(board: ManagedTaskBoard): Tool {
  return {
    descriptor: {
      name: "task_delegate",
      description:
        "Delegate a pending task to a child agent for execution. " +
        "Unlike task_update, this allows multiple tasks to be delegated simultaneously — " +
        "use it when coordinating parallel work across multiple agents. " +
        "The child agent's ID is recorded as assignedTo on the task.",
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
      const childAgentId: AgentId = mkAgentId(agent_id);
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

      // board.assign() — direct state transition, no single-in-progress guard.
      // Coordinators fan-out N tasks; the guard lives only in task_update.
      const assignResult = await board.assign(id, childAgentId);
      if (!assignResult.ok) {
        return { ok: false, error: assignResult.error.message };
      }

      const updatedTask = board.snapshot().get(id);
      return {
        ok: true,
        task:
          updatedTask !== undefined
            ? toTaskSummary(updatedTask, board.snapshot())
            : ({ id } satisfies { id: TaskItemId }),
      };
    },
  };
}

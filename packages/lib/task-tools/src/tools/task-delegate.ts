import type { JsonObject, ManagedTaskBoard, TaskItemId, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the pending task to delegate"),
  agent_id: z.string().min(1).describe("ID of the child agent that will execute this task"),
});

/**
 * task_delegate — coordinator soft-delegation tool.
 *
 * Records which child agent should handle a task by writing
 * `metadata.delegatedTo = agent_id`. The coordinator retains board
 * ownership (assignedTo is NOT changed), so it can still complete,
 * fail, or stop the task after agent_spawn returns.
 *
 * Board ownership handoff to the spawned child's runtime AgentId
 * requires engine-level identity resolution — deferred to #1416.
 * Until then, the coordinator is responsible for closing the task.
 *
 * Only pending tasks may be delegated. Already-delegated (metadata.delegatedTo
 * set), completed, failed, and killed tasks are rejected.
 */
export function createTaskDelegateTool(board: ManagedTaskBoard): Tool {
  return {
    descriptor: {
      name: "task_delegate",
      description:
        "Record which child agent should handle a pending task. " +
        "Stores the agent ID in task metadata (delegatedTo) so the coordinator " +
        "can track intent. The coordinator retains ownership and must complete or " +
        "fail the task after agent_spawn returns — child agents cannot update it " +
        "directly until #1416 is resolved.",
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
      // Prevent re-delegation of an already-delegated task.
      if (task.metadata?.delegatedTo !== undefined) {
        return {
          ok: false,
          error:
            `Task '${task_id}' is already delegated to '${String(task.metadata.delegatedTo)}'. ` +
            "Undelegate first or create a new task.",
        };
      }

      // Soft delegation: record intent in metadata, coordinator keeps ownership.
      // No board.assign() — avoids creating an ownership state that no spawned
      // child can satisfy (their runtime AgentId won't match #1416).
      const updateResult = await board.update(id, { metadata: { delegatedTo: agent_id } });
      if (!updateResult.ok) {
        return { ok: false, error: updateResult.error.message };
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

import type { AgentId, JsonObject, KoiError, ManagedTaskBoard, TaskItemId, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";
import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the task to update"),
  subject: z.string().min(1).optional().describe("New short title for the task"),
  description: z.string().min(1).optional().describe("New full description"),
  active_form: z
    .string()
    .optional()
    .describe("Update the present-continuous spinner text. Cleared automatically on completion."),
  status: z
    .enum(["in_progress", "completed", "failed", "killed"])
    .optional()
    .describe(
      "Transition task status. 'in_progress' = start working (only one allowed at a time); " +
        "'completed' = done (requires output); 'failed' = errored (requires reason); 'killed' = cancelled.",
    ),
  output: z
    .string()
    .optional()
    .describe("Required when status = 'completed'. Summary of what was accomplished."),
  reason: z
    .string()
    .optional()
    .describe("Required when status = 'failed'. Explanation of why the task failed."),
});

export function createTaskUpdateTool(
  board: ManagedTaskBoard,
  agentId: AgentId,
  onComplete: (taskSubject: string) => void,
): Tool {
  return {
    descriptor: {
      name: "task_update",
      description:
        "Update a task's status, description, or progress text. " +
        "Set status to 'in_progress' when starting work (only one task may be in_progress at a time). " +
        "Set status to 'completed' with an output summary when done. " +
        "Set status to 'failed' with a reason if the task errored. " +
        "Set status to 'killed' to cancel. " +
        "Update active_form to change the live progress text shown in the spinner.",
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

      const { task_id, subject, description, active_form, status, output, reason } = parsed.data;
      const id = taskItemId(task_id);
      const snapshot = board.snapshot();
      const task = snapshot.get(id);

      if (task === undefined) {
        return { ok: false, error: `Task not found: ${task_id}` };
      }

      if (status !== undefined) {
        if (status === "in_progress") {
          // Single-in-progress enforcement (Decision 3A)
          const inProgress = snapshot.inProgress();
          if (inProgress.length > 0) {
            const blocking = inProgress[0];
            return {
              ok: false,
              error:
                `Cannot start task '${task_id}': task '${(blocking?.id as string | undefined) ?? "unknown"}' is already in_progress. ` +
                "Complete or stop the current task first.",
            };
          }
          const assignResult = await board.assign(id, agentId);
          if (!assignResult.ok) {
            return { ok: false, error: assignResult.error.message };
          }
          if (active_form !== undefined) {
            const patchResult = await board.update(id, { activeForm: active_form });
            if (!patchResult.ok) {
              return { ok: false, error: patchResult.error.message };
            }
          }
          const updatedTask = board.snapshot().get(id);
          return {
            ok: true,
            task:
              updatedTask !== undefined
                ? toTaskSummary(updatedTask, board.snapshot())
                : ({ id } satisfies { id: TaskItemId }),
          };
        }

        if (status === "completed") {
          // Ownership check: only the assigned agent may complete an in_progress task
          if (task.status === "in_progress" && task.assignedTo !== agentId) {
            return {
              ok: false,
              error: `Cannot complete task '${task_id}': it is assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
            };
          }
          // Fail fast: completing a task without durable result storage means
          // the output will be silently lost after any process restart, leaving
          // the task as `completed` with no recoverable output via task_output.
          if (!board.hasResultPersistence()) {
            return {
              ok: false,
              error:
                "Cannot complete task: result storage is not durable. " +
                "Create the ManagedTaskBoard with a resultsDir so completed outputs survive restarts.",
            };
          }
          if (output === undefined || output.trim() === "") {
            return {
              ok: false,
              error:
                "status 'completed' requires a non-empty 'output' field summarizing what was accomplished",
            };
          }
          const taskResult = { taskId: id, output, durationMs: 0 };
          const completeResult = await board.complete(id, taskResult);
          if (!completeResult.ok) {
            return { ok: false, error: completeResult.error.message };
          }
          onComplete(task.subject);
          const updatedTask = board.snapshot().get(id);
          return {
            ok: true,
            task:
              updatedTask !== undefined
                ? toTaskSummary(updatedTask, board.snapshot())
                : ({ id } satisfies { id: TaskItemId }),
            result: taskResult,
          };
        }

        if (status === "failed") {
          // Ownership check: only the assigned agent may fail an in_progress task
          if (task.status === "in_progress" && task.assignedTo !== agentId) {
            return {
              ok: false,
              error: `Cannot fail task '${task_id}': it is assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
            };
          }
          if (reason === undefined || reason.trim() === "") {
            return {
              ok: false,
              error:
                "status 'failed' requires a non-empty 'reason' field explaining why the task failed",
            };
          }
          const err: KoiError = { code: "EXTERNAL", message: reason, retryable: false };
          const failResult = await board.fail(id, err);
          if (!failResult.ok) {
            return { ok: false, error: failResult.error.message };
          }
          const updatedTask = board.snapshot().get(id);
          return {
            ok: true,
            task:
              updatedTask !== undefined
                ? toTaskSummary(updatedTask, board.snapshot())
                : ({ id } satisfies { id: TaskItemId }),
          };
        }

        // status === "killed": ownership check for in_progress tasks
        if (task.status === "in_progress" && task.assignedTo !== agentId) {
          return {
            ok: false,
            error: `Cannot kill task '${task_id}': it is assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
          };
        }
        const killResult = await board.kill(id);
        if (!killResult.ok) {
          return { ok: false, error: killResult.error.message };
        }
        const updatedTask = board.snapshot().get(id);
        return {
          ok: true,
          task:
            updatedTask !== undefined
              ? toTaskSummary(updatedTask, board.snapshot())
              : ({ id } satisfies { id: TaskItemId }),
        };
      }

      // Metadata-only update
      const hasPatch =
        subject !== undefined || description !== undefined || "active_form" in parsed.data;
      if (!hasPatch) {
        return {
          ok: false,
          error: "No fields to update — provide subject, description, active_form, or status",
        };
      }

      const patch = {
        ...(subject !== undefined ? { subject } : {}),
        ...(description !== undefined ? { description } : {}),
        ...("active_form" in parsed.data ? { activeForm: active_form } : {}),
      };

      const patchResult = await board.update(id, patch);
      if (!patchResult.ok) {
        return { ok: false, error: patchResult.error.message };
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

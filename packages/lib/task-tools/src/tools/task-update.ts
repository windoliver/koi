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
  results: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional when status = 'completed'. Structured result data (e.g. { count: 5, files: [...] }). " +
        "Validated against resultSchemas[task.metadata.kind] if configured.",
    ),
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

      const { task_id, subject, description, active_form, status, output, results, reason } =
        parsed.data;
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
            // Task is now in_progress and owned by agentId — updateOwned enforces that
            const patchResult = await board.updateOwned(id, agentId, { activeForm: active_form });
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
          // Fail fast: completing a task without durable result storage means
          // the output will be silently lost after any process restart.
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
          // durationMs: time since the task's last state change (when it became in_progress).
          // task.updatedAt reflects the most recent transition — the in_progress assignment.
          const durationMs = Math.max(0, Date.now() - task.updatedAt);
          const taskResult = {
            taskId: id,
            output,
            durationMs,
            ...(results !== undefined ? { results } : {}),
          };
          // completeOwnedTask: atomically re-checks ownership inside the lock
          const completeResult = await board.completeOwnedTask(id, agentId, taskResult);
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
          if (reason === undefined || reason.trim() === "") {
            return {
              ok: false,
              error:
                "status 'failed' requires a non-empty 'reason' field explaining why the task failed",
            };
          }
          const err: KoiError = { code: "EXTERNAL", message: reason, retryable: false };
          // failOwnedTask: atomically re-checks ownership inside the lock
          const failResult = await board.failOwnedTask(id, agentId, err);
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

        // status === "killed": killOwnedTask re-checks ownership inside the lock
        const killResult = await board.killOwnedTask(id, agentId);
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

      // updateOwned: atomically rejects cross-agent writes on in_progress tasks
      const patchResult = await board.updateOwned(id, agentId, patch);
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

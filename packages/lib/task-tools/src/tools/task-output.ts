import type { AgentId, JsonObject, ManagedTaskBoard, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";
import type { ResultSchema, TaskOutputResponse, TaskToolsConfig } from "../types.js";

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the task to retrieve output for"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte offset for incremental output reads. When provided for in_progress tasks, returns only output since that offset.",
    ),
});

export function createTaskOutputTool(
  board: ManagedTaskBoard,
  agentId: AgentId,
  config: Pick<TaskToolsConfig, "resultSchemas" | "outputReader">,
): Tool {
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
          // If offset is provided and an output reader is available, return delta chunks
          if (parsed.data.offset !== undefined && config.outputReader !== undefined) {
            const readResult = config.outputReader.readOutput(id, parsed.data.offset);
            if (readResult.ok) {
              const response: TaskOutputResponse = {
                kind: "in_progress_output",
                task: toTaskSummary(task, snapshot),
                chunks: readResult.value.chunks,
                nextOffset: readResult.value.nextOffset,
              };
              return response;
            }
            // Fall through to status-only response if read fails (task might not be tracked by runner)
          }
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
          // Opt-in result schema validation — keyed by task.metadata.kind
          if (result.results !== undefined && config.resultSchemas !== undefined) {
            const kind = task.metadata?.kind;
            if (typeof kind === "string") {
              const resultSchema: ResultSchema | undefined = config.resultSchemas[kind];
              if (resultSchema !== undefined) {
                const v = resultSchema.safeParse(result.results);
                if (!v.success) {
                  const response: TaskOutputResponse = {
                    kind: "completed",
                    result,
                    resultsValidationError: v.error.message,
                  };
                  return response;
                }
              }
            }
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

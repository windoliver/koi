import type {
  AgentId,
  JsonObject,
  ManagedTaskBoard,
  TaskOutputReaderMatchesResult,
  Tool,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";
import type { ResultSchema, TaskOutputResponse, TaskToolsConfig } from "../types.js";

const EMPTY_MATCHES_RESULT: TaskOutputReaderMatchesResult = {
  kind: "matches",
  entries: [],
  cursor: "s=0",
  dropped_before_cursor: 0,
  truncated: false,
};

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
  matches_only: z
    .boolean()
    .optional()
    .describe(
      "If true, return matched-line side-buffer entries instead of the main output stream. " +
        "Requires bufferReader to be configured. Returns empty result if no buffer exists.",
    ),
  event: z
    .string()
    .optional()
    .describe(
      "Optional filter (matches_only=true only): restrict to matches with this event label.",
    ),
  stream: z
    .enum(["stdout", "stderr"])
    .optional()
    .describe("Optional filter (matches_only=true only): restrict to stdout or stderr matches."),
  match_offset: z
    .string()
    .optional()
    .describe(
      "Opaque pagination cursor returned by a prior matches_only call. " +
        "Pass the cursor field from a prior response to page forward.",
    ),
});

export function createTaskOutputTool(
  board: ManagedTaskBoard,
  agentId: AgentId,
  config: Pick<
    TaskToolsConfig,
    "resultSchemas" | "outputReader" | "bufferReader" | "legacyReadOwner"
  >,
): Tool {
  return {
    descriptor: {
      name: "task_output",
      description:
        "Retrieve the output or current status of a task. " +
        "Returns full TaskResult for completed tasks, status info for pending/in_progress tasks, " +
        "and error details for failed/killed tasks. " +
        "Use matches_only=true to retrieve matched-line side-buffer entries for tasks with watch_patterns.",
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

      // Read ACL: allow when caller is the creator or the current assignee.
      // Legacy tasks (createdBy === undefined) are readable only by legacyReadOwner
      // (defaults to the session agentId) — fail-closed otherwise so pre-migration
      // records do not become universally readable in multi-agent sessions.
      const isCreator = task.createdBy === agentId;
      const isAssignee = task.assignedTo !== undefined && task.assignedTo === agentId;
      const legacyReadOwner = config.legacyReadOwner ?? agentId;
      const isLegacyReadable =
        task.createdBy === undefined &&
        legacyReadOwner !== undefined &&
        legacyReadOwner === agentId;
      if (!isCreator && !isAssignee && !isLegacyReadable) {
        const deniedResponse: TaskOutputResponse = {
          kind: "permission_denied",
          reason: "Not authorized to read this task's output.",
        };
        return deniedResponse;
      }

      // matches_only path: return matched-line side-buffer entries
      if (parsed.data.matches_only === true) {
        const reader = config.bufferReader?.(id);
        if (reader === undefined) {
          return EMPTY_MATCHES_RESULT;
        }
        return reader.queryMatches({
          ...(typeof parsed.data.event === "string" ? { event: parsed.data.event } : {}),
          ...(parsed.data.stream !== undefined ? { stream: parsed.data.stream } : {}),
          ...(typeof parsed.data.match_offset === "string"
            ? { offset: parsed.data.match_offset }
            : {}),
        });
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
            // Fall through to buffered-snapshot or status-only response
          }
          // If a bufferReader is wired, return buffered snapshot for in_progress
          const inProgressBuffer = config.bufferReader?.(id);
          if (inProgressBuffer !== undefined) {
            const snap = inProgressBuffer.snapshot();
            return {
              kind: "in_progress",
              task: toTaskSummary(task, snapshot),
              stdout: snap.stdout,
              stderr: snap.stderr,
              truncated: snap.truncated,
            };
          }
          const inProgressResponse: TaskOutputResponse = {
            kind: "in_progress",
            task: toTaskSummary(task, snapshot),
          };
          return inProgressResponse;
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
          // Return buffered snapshot when available (terminal state — process has exited)
          const failedBuffer = config.bufferReader?.(id);
          if (failedBuffer !== undefined) {
            const snap = failedBuffer.snapshot();
            return {
              kind: "failed",
              task,
              error: task.error ?? {
                code: "EXTERNAL",
                message: "Task failed with no error details",
                retryable: false,
              },
              stdout: snap.stdout,
              stderr: snap.stderr,
              truncated: snap.truncated,
            };
          }
          const failedResponse: TaskOutputResponse = {
            kind: "failed",
            task,
            error: task.error ?? {
              code: "EXTERNAL",
              message: "Task failed with no error details",
              retryable: false,
            },
          };
          return failedResponse;
        }
        case "killed": {
          // Return buffered snapshot when available (terminal state — process has exited)
          const killedBuffer = config.bufferReader?.(id);
          if (killedBuffer !== undefined) {
            const snap = killedBuffer.snapshot();
            return {
              kind: "killed",
              task,
              stdout: snap.stdout,
              stderr: snap.stderr,
              truncated: snap.truncated,
            };
          }
          const killedResponse: TaskOutputResponse = { kind: "killed", task };
          return killedResponse;
        }
      }
    },
  };
}

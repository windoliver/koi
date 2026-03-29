/**
 * Task tools — dynamic tools for managing autonomous task execution.
 *
 * These tools are registered dynamically via ForgeRuntime when autonomous
 * mode activates, and unregistered when it deactivates:
 * - `task_complete`: Mark a task as completed
 * - `task_update`: Update a task's description or status
 * - `task_status`: Get current task board summary
 * - `task_review`: Accept/reject/revise a completed task's output
 * - `task_synthesize`: Merge all results in dependency order
 */

import type { JsonObject, TaskBoardSnapshot, TaskItemId, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, taskItemId } from "@koi/core";
import {
  createTaskBoard,
  isRecord,
  parseEnumField,
  parseStringField,
  snapshotToItemsMap,
  topologicalSort,
} from "@koi/task-board";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskToolsConfig {
  /** Get the current task board snapshot. */
  readonly getTaskBoard: () => TaskBoardSnapshot;
  /** Mark a task as completed with output. */
  readonly completeTask: (taskId: TaskItemId, output: string) => Promise<void>;
  /** Update a task's description. */
  readonly updateTask: (taskId: TaskItemId, description: string) => Promise<void>;
  /**
   * Fail a task with a retryable error (for review reject/revise).
   * Returns the updated snapshot or undefined if not supported.
   */
  readonly failTask?: (
    taskId: TaskItemId,
    message: string,
  ) => Promise<TaskBoardSnapshot | undefined>;
  /** Maximum characters per task in synthesize output. Default: 5000. */
  readonly maxOutputPerTask?: number | undefined;
}

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

const TASK_COMPLETE_DESCRIPTOR: ToolDescriptor = {
  name: "task_complete",
  description:
    "Mark a task as completed and report its output. Call this after you finish " +
    "a task from the autonomous plan. The output should summarize what was done " +
    "and any artifacts produced — downstream tasks may depend on this output. " +
    "Returns the number of remaining tasks; when 0, autonomous execution ends.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The id of the task to complete (must match an id from plan_autonomous).",
      },
      output: {
        type: "string",
        description:
          "Summary of what was accomplished. Include key results, file paths, " +
          "or findings that dependent tasks will need.",
      },
    },
    required: ["task_id", "output"],
  },
};

const TASK_UPDATE_DESCRIPTOR: ToolDescriptor = {
  name: "task_update",
  description:
    "Revise a task's description before or during execution. Use when you discover " +
    "the original description is incomplete, ambiguous, or needs refinement based " +
    "on findings from earlier tasks.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The id of the task to update (must match an id from plan_autonomous).",
      },
      description: {
        type: "string",
        description: "Updated task description replacing the original.",
      },
    },
    required: ["task_id", "description"],
  },
};

const TASK_STATUS_DESCRIPTOR: ToolDescriptor = {
  name: "task_status",
  description:
    "Check progress on the autonomous plan. Returns counts by status " +
    "(pending, assigned, completed, failed) and the full task list with " +
    "current statuses. Call this to decide what to work on next or to " +
    "verify all tasks are done before finishing.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const TASK_REVIEW_DESCRIPTOR: ToolDescriptor = {
  name: "task_review",
  description:
    "Review a completed task's output. Verdict: 'accept' to keep the result, " +
    "'reject' to fail and retry from scratch, 'revise' to retry with feedback. " +
    "The task will be re-queued for retry if retries remain.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The id of the completed task to review.",
      },
      verdict: {
        type: "string",
        description: "One of: 'accept', 'reject', 'revise'.",
      },
      feedback: {
        type: "string",
        description: "Optional feedback for reject/revise — included in the retry context.",
      },
    },
    required: ["task_id", "verdict"],
  },
};

const TASK_SYNTHESIZE_DESCRIPTOR: ToolDescriptor = {
  name: "task_synthesize",
  description:
    "Synthesize all completed task results into a final output. " +
    "Results are ordered by dependency (topological order). Use this " +
    "after all tasks are done to produce a unified summary.",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        description: "Output format: 'summary' (default), 'detailed', or 'structured'.",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Review executor
// ---------------------------------------------------------------------------

function executeTaskReview(raw: JsonObject, config: TaskToolsConfig): string | Promise<string> {
  if (!isRecord(raw)) return "Input must be a non-null object";

  const taskIdResult = parseStringField(raw, "task_id");
  if (typeof taskIdResult === "object") return taskIdResult.error;

  const verdictResult = parseEnumField(raw, "verdict", ["accept", "reject", "revise"] as const);
  if (typeof verdictResult === "object") return verdictResult.error;

  const id = taskItemId(taskIdResult);
  const board = config.getTaskBoard();
  const item = board.items.find((i) => i.id === id);

  if (item === undefined) {
    return `Task not found: ${taskIdResult}`;
  }

  if (verdictResult === "accept") {
    return `Task ${taskIdResult} accepted.`;
  }

  // For reject/revise, fail the task with retryable error
  if (config.failTask === undefined) {
    return `Review not supported: failTask callback not configured.`;
  }

  const feedback = typeof raw.feedback === "string" ? raw.feedback : undefined;
  const message =
    verdictResult === "reject"
      ? `Rejected: ${feedback ?? "no feedback"}`
      : `Revision needed: ${feedback ?? "no feedback"}`;

  return Promise.resolve(config.failTask(id, message)).then((updatedBoard) => {
    if (updatedBoard === undefined) {
      return `Cannot ${verdictResult} task ${taskIdResult}: operation failed.`;
    }

    const updated = updatedBoard.items.find((i) => i.id === id);
    if (updated?.status === "pending") {
      return `Task ${taskIdResult} ${verdictResult}ed — queued for retry (attempt ${updated.retries}/${updated.maxRetries}).${feedback ? ` Feedback: ${feedback}` : ""}`;
    }

    return `Task ${taskIdResult} ${verdictResult}ed — retries exhausted, marked as failed.${feedback ? ` Feedback: ${feedback}` : ""}`;
  });
}

// ---------------------------------------------------------------------------
// Synthesize executor
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_PER_TASK = 5000;

function executeTaskSynthesize(raw: JsonObject, config: TaskToolsConfig): string {
  const board = config.getTaskBoard();
  const liveBoard = createTaskBoard(undefined, board);
  const results = liveBoard.completed();

  if (results.length === 0) {
    return "No completed tasks to synthesize.";
  }

  const maxOutput = config.maxOutputPerTask ?? DEFAULT_MAX_OUTPUT_PER_TASK;

  // Build result lookup
  const resultMap = new Map(results.map((r) => [r.taskId, r] as const));

  // Get items map for topological sort
  const itemsMap = snapshotToItemsMap(liveBoard);
  const sorted = topologicalSort(itemsMap);
  const orderedIds = sorted.filter((id) => resultMap.has(id));

  // Parse format
  const format =
    isRecord(raw) &&
    (raw.format === "summary" || raw.format === "detailed" || raw.format === "structured")
      ? raw.format
      : "summary";

  const sections: string[] = [];
  for (const id of orderedIds) {
    const item = liveBoard.get(id);
    const taskResult = resultMap.get(id);
    const output = taskResult?.output ?? "";
    const truncated =
      output.length > maxOutput ? `${output.slice(0, maxOutput)}... (truncated)` : output;

    const header = item !== undefined ? `## ${id}: ${item.description}` : `## ${id}`;
    const parts: string[] = [`${header}\n${truncated}`];

    if (taskResult?.artifacts !== undefined && taskResult.artifacts.length > 0) {
      const artLines = taskResult.artifacts.map((a) => `- ${a.kind}: ${a.uri}`);
      parts.push(`\n### Artifacts\n${artLines.join("\n")}`);
    }

    if (taskResult?.warnings !== undefined && taskResult.warnings.length > 0) {
      parts.push(`\n### Warnings\n${taskResult.warnings.map((w) => `- ${w}`).join("\n")}`);
    }

    if (taskResult?.decisions !== undefined && taskResult.decisions.length > 0) {
      const decLines = taskResult.decisions.map(
        (d) => `- [${d.agentId}] ${d.action}: ${d.reasoning}`,
      );
      parts.push(`\n### Decisions\n${decLines.join("\n")}`);
    }

    sections.push(parts.join(""));
  }

  return `# Synthesis (${format}) — ${results.length} task(s)\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create task management tools for autonomous execution.
 * These should be registered dynamically via ForgeRuntime when
 * autonomous mode activates.
 */
export function createTaskTools(config: TaskToolsConfig): readonly Tool[] {
  const taskComplete: Tool = {
    descriptor: TASK_COMPLETE_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const tid = typeof args.task_id === "string" ? args.task_id : undefined;
      const output = typeof args.output === "string" ? args.output : undefined;
      if (tid === undefined || output === undefined) {
        return { error: "task_id and output are required strings" };
      }
      await config.completeTask(taskItemId(tid), output);
      const board = config.getTaskBoard();
      const remaining = board.items.filter((i) => i.status !== "completed").length;
      return {
        status: "completed",
        taskId: tid,
        remainingTasks: remaining,
        message: remaining === 0 ? "All tasks completed!" : `${remaining} tasks remaining.`,
      };
    },
  };

  const taskUpdate: Tool = {
    descriptor: TASK_UPDATE_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const tid = typeof args.task_id === "string" ? args.task_id : undefined;
      const description = typeof args.description === "string" ? args.description : undefined;
      if (tid === undefined || description === undefined) {
        return { error: "task_id and description are required strings" };
      }
      await config.updateTask(taskItemId(tid), description);
      return { status: "updated", taskId: tid };
    },
  };

  const taskStatus: Tool = {
    descriptor: TASK_STATUS_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (_args: JsonObject): Promise<unknown> => {
      const board = config.getTaskBoard();
      const counts: Record<string, number> = { pending: 0, assigned: 0, completed: 0, failed: 0 };
      for (const item of board.items) {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
      }
      return {
        totalTasks: board.items.length,
        pending: counts.pending ?? 0,
        assigned: counts.assigned ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        tasks: board.items.map((i) => ({
          id: i.id,
          description: i.description,
          status: i.status,
        })),
      };
    },
  };

  const taskReview: Tool = {
    descriptor: TASK_REVIEW_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const result = await executeTaskReview(args, config);
      return { message: result };
    },
  };

  const taskSynthesize: Tool = {
    descriptor: TASK_SYNTHESIZE_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const result = executeTaskSynthesize(args, config);
      return { message: result };
    },
  };

  return [taskComplete, taskUpdate, taskStatus, taskReview, taskSynthesize];
}

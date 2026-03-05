/**
 * Task tools — dynamic tools for managing autonomous task execution (Decision 7B).
 *
 * These tools are registered dynamically via ForgeRuntime when autonomous
 * mode activates, and unregistered when it deactivates:
 * - `task_complete`: Mark a task as completed
 * - `task_update`: Update a task's description or status
 * - `task_status`: Get current task board summary
 */

import type { JsonObject, TaskBoardSnapshot, TaskItemId, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, taskItemId } from "@koi/core";

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
      const pending = board.items.filter((i) => i.status === "pending").length;
      const assigned = board.items.filter((i) => i.status === "assigned").length;
      const completed = board.items.filter((i) => i.status === "completed").length;
      const failed = board.items.filter((i) => i.status === "failed").length;
      return {
        totalTasks: board.items.length,
        pending,
        assigned,
        completed,
        failed,
        tasks: board.items.map((i) => ({
          id: i.id,
          description: i.description,
          status: i.status,
        })),
      };
    },
  };

  return [taskComplete, taskUpdate, taskStatus];
}

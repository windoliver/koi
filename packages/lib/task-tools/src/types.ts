/**
 * Shared types for @koi/task-tools — projections, response shapes, and config.
 */

import type {
  AgentId,
  KoiError,
  ManagedTaskBoard,
  Task,
  TaskItemId,
  TaskResult,
  TaskStatus,
} from "@koi/core";

// ---------------------------------------------------------------------------
// TaskSummary — lean projection for task_list responses
// ---------------------------------------------------------------------------

/**
 * Lean summary of a task for list responses.
 * Full task details (metadata, timestamps) are available via task_get.
 */
export interface TaskSummary {
  readonly id: TaskItemId;
  readonly subject: string;
  readonly status: TaskStatus;
  readonly activeForm?: string | undefined;
  readonly assignedTo?: AgentId | undefined;
  readonly dependencies: readonly TaskItemId[];
  /** First dependency that is not yet completed — set when task is blocked. */
  readonly blockedBy?: TaskItemId | undefined;
}

// ---------------------------------------------------------------------------
// TaskOutputResponse — discriminated union for all task_output outcomes
// ---------------------------------------------------------------------------

export type TaskOutputResponse =
  | { readonly kind: "not_found"; readonly taskId: TaskItemId }
  | { readonly kind: "pending"; readonly task: TaskSummary }
  | { readonly kind: "in_progress"; readonly task: TaskSummary }
  | { readonly kind: "completed"; readonly result: TaskResult }
  | { readonly kind: "failed"; readonly task: Task; readonly error: KoiError }
  | { readonly kind: "killed"; readonly task: Task }
  | {
      readonly kind: "completed_no_result";
      readonly taskId: TaskItemId;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// TaskToolsConfig
// ---------------------------------------------------------------------------

export interface TaskToolsConfig {
  readonly board: ManagedTaskBoard;
  /**
   * Agent ID used when assigning tasks via task_update → status: "in_progress".
   * Typically the ID of the agent that owns this tool set.
   */
  readonly agentId: AgentId;
}

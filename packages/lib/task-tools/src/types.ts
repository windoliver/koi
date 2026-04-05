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

/**
 * Minimal interface for result validation schemas.
 * Satisfied by any Zod schema (z.object, z.record, etc.) without coupling
 * the public types to a specific validation library.
 */
export interface ResultSchema {
  readonly safeParse: (
    val: unknown,
  ) =>
    | { readonly success: true }
    | { readonly success: false; readonly error: { readonly message: string } };
}

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
  | {
      readonly kind: "completed";
      readonly result: TaskResult;
      /** Present when resultSchemas is configured and validation fails. */
      readonly resultsValidationError?: string | undefined;
    }
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
  /**
   * Optional per-kind Zod schemas for validating TaskResult.results.
   * Key: task.metadata.kind (string). When a completed task's results
   * don't match its registered schema, task_output returns resultsValidationError.
   * Opt-in — tasks with no registered schema are not validated.
   */
  readonly resultSchemas?: Readonly<Record<string, ResultSchema>> | undefined;
}

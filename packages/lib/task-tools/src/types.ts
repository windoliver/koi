/**
 * Shared types for @koi/task-tools — projections, response shapes, and config.
 */

import type {
  AgentId,
  KoiError,
  ManagedTaskBoard,
  Task,
  TaskItemId,
  TaskOutputReader,
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
  | {
      readonly kind: "in_progress";
      readonly task: TaskSummary;
      readonly stdout?: string | undefined;
      readonly stderr?: string | undefined;
      readonly truncated?: boolean | undefined;
    }
  | {
      readonly kind: "in_progress_output";
      readonly task: TaskSummary;
      readonly chunks: readonly OutputChunkData[];
      readonly nextOffset: number;
    }
  | {
      readonly kind: "completed";
      readonly result: TaskResult;
      /** Present when resultSchemas is configured and validation fails. */
      readonly resultsValidationError?: string | undefined;
    }
  | {
      readonly kind: "failed";
      readonly task: Task;
      readonly error: KoiError;
      readonly stdout?: string | undefined;
      readonly stderr?: string | undefined;
      readonly truncated?: boolean | undefined;
    }
  | {
      readonly kind: "killed";
      readonly task: Task;
      readonly stdout?: string | undefined;
      readonly stderr?: string | undefined;
      readonly truncated?: boolean | undefined;
    }
  | {
      readonly kind: "completed_no_result";
      readonly taskId: TaskItemId;
      readonly message: string;
    }
  | {
      readonly kind: "permission_denied";
      readonly reason: string;
    }
  | {
      readonly kind: "validation_failed";
      readonly reason: string;
    }
  | {
      /**
       * The task reached a terminal state (completed/failed/killed) and its
       * output buffer has been evicted from the LRU cache. Distinguishes
       * "task never produced matches" (kind: "matches", entries: []) from
       * "matches may have been produced but are no longer retrievable".
       */
      readonly kind: "buffer_evicted";
      readonly reason: string;
    };

/** Serializable output chunk data (no methods). */
export interface OutputChunkData {
  readonly offset: number;
  readonly content: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// TaskToolsConfig
// ---------------------------------------------------------------------------

/**
 * Minimal interface for reading incremental chunk-based task output.
 * Matches TaskRunner.readOutput() without depending on the full TaskRunner type.
 * Used by task_output's `offset`-based incremental streaming path.
 */
export interface TaskChunkReader {
  readonly readOutput: (
    taskId: TaskItemId,
    fromOffset?: number,
  ) =>
    | {
        readonly ok: true;
        readonly value: {
          readonly chunks: readonly OutputChunkData[];
          readonly nextOffset: number;
        };
      }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
}

export interface TaskToolsConfig {
  readonly board: ManagedTaskBoard;
  /**
   * Agent ID used when assigning tasks via task_update → status: "in_progress".
   * Typically the ID of the agent that owns this tool set.
   */
  readonly agentId: AgentId;
  /**
   * Agent allowed to read tasks persisted before createdBy existed.
   * Defaults to the session's main agentId. Set to a specific agent (or leave
   * undefined to deny all legacy reads) in multi-agent sessions.
   *
   * Legacy tasks (createdBy === undefined) are readable ONLY by this agent.
   * All other callers receive permission_denied even if legacyReadOwner is set.
   */
  readonly legacyReadOwner?: AgentId | undefined;
  /**
   * Optional per-kind Zod schemas for validating TaskResult.results.
   * Key: task.metadata.kind (string). When a completed task's results
   * don't match its registered schema, task_output returns resultsValidationError.
   * Opt-in — tasks with no registered schema are not validated.
   */
  readonly resultSchemas?: Readonly<Record<string, ResultSchema>> | undefined;
  /**
   * Optional chunk-based output reader for incremental streaming reads.
   * When provided, task_output accepts an `offset` parameter to return
   * delta output chunks for in_progress tasks.
   */
  readonly outputReader?: TaskChunkReader | undefined;
  /**
   * Optional buffer reader factory for matches_only and buffered-snapshot reads.
   * Returns a TaskOutputReader (snapshot + queryMatches) for the given task ID,
   * or undefined if no buffer exists for that task.
   *
   * Structurally satisfied by BashOutputBuffer from @koi/tools-bash without
   * creating an L2→L2 import dependency — wire via dependency injection at L3/L4.
   */
  readonly bufferReader?: ((taskId: TaskItemId) => TaskOutputReader | undefined) | undefined;
}

// Re-export TaskOutputReader from @koi/core so callers can reference it without
// importing directly from @koi/core when working with TaskToolsConfig.
export type { TaskOutputReader };

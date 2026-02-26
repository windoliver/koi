/**
 * TaskBoard contract — persistent task coordination for multi-agent swarms.
 *
 * A TaskBoard maintains a DAG of tasks with dependency tracking,
 * assignment, completion, failure/retry, and board-level queries.
 *
 * Exception: branded type constructor (taskItemId) is permitted in L0
 * as a zero-logic identity cast for type safety.
 * Exception: DEFAULT_TASK_BOARD_CONFIG is a pure readonly data constant
 * derived from L0 type definitions.
 */

import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __taskItemBrand: unique symbol;

/** Branded string type for task board item identifiers. */
export type TaskItemId = string & { readonly [__taskItemBrand]: "TaskItemId" };

// ---------------------------------------------------------------------------
// Branded type constructors (zero-logic casts)
// ---------------------------------------------------------------------------

/** Create a branded TaskItemId from a plain string. */
export function taskItemId(id: string): TaskItemId {
  return id as TaskItemId;
}

// ---------------------------------------------------------------------------
// Task item status
// ---------------------------------------------------------------------------

export type TaskItemStatus = "pending" | "assigned" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Task item — a unit of work on the board
// ---------------------------------------------------------------------------

/** Input shape for adding a task to the board. */
export interface TaskItemInput {
  readonly id: TaskItemId;
  readonly description: string;
  readonly dependencies?: readonly TaskItemId[] | undefined;
  readonly priority?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** A task item on the board with full state. */
export interface TaskItem {
  readonly id: TaskItemId;
  readonly description: string;
  readonly dependencies: readonly TaskItemId[];
  readonly priority: number;
  readonly maxRetries: number;
  readonly retries: number;
  readonly status: TaskItemStatus;
  readonly assignedTo?: AgentId | undefined;
  readonly error?: KoiError | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Result produced by a completed task. */
export interface TaskResult {
  readonly taskId: TaskItemId;
  readonly output: string;
  readonly durationMs: number;
  readonly workerId?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Patch fields for updating a pending or assigned task. */
export interface TaskItemPatch {
  readonly priority?: number | undefined;
  readonly description?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Board events (discriminated union)
// ---------------------------------------------------------------------------

export type TaskBoardEvent =
  | { readonly kind: "task:added"; readonly item: TaskItem }
  | { readonly kind: "task:assigned"; readonly taskId: TaskItemId; readonly agentId: AgentId }
  | { readonly kind: "task:completed"; readonly taskId: TaskItemId; readonly result: TaskResult }
  | { readonly kind: "task:failed"; readonly taskId: TaskItemId; readonly error: KoiError }
  | { readonly kind: "task:retried"; readonly taskId: TaskItemId; readonly retries: number };

// ---------------------------------------------------------------------------
// Board snapshot (serialization)
// ---------------------------------------------------------------------------

export interface TaskBoardSnapshot {
  readonly items: readonly TaskItem[];
  readonly results: readonly TaskResult[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TaskBoardConfig {
  readonly maxRetries?: number | undefined;
  readonly onEvent?: ((event: TaskBoardEvent) => void) | undefined;
}

export const DEFAULT_TASK_BOARD_CONFIG: TaskBoardConfig = Object.freeze({
  maxRetries: 3,
});

// ---------------------------------------------------------------------------
// TaskBoard interface
// ---------------------------------------------------------------------------

export interface TaskBoard {
  // Mutations — return a new board or an error
  readonly add: (item: TaskItemInput) => Result<TaskBoard, KoiError>;
  readonly addAll: (items: readonly TaskItemInput[]) => Result<TaskBoard, KoiError>;
  readonly assign: (taskId: TaskItemId, agentId: AgentId) => Result<TaskBoard, KoiError>;
  readonly complete: (taskId: TaskItemId, result: TaskResult) => Result<TaskBoard, KoiError>;
  readonly fail: (taskId: TaskItemId, error: KoiError) => Result<TaskBoard, KoiError>;
  readonly update: (taskId: TaskItemId, patch: TaskItemPatch) => Result<TaskBoard, KoiError>;

  // Queries
  readonly get: (taskId: TaskItemId) => TaskItem | undefined;
  readonly ready: () => readonly TaskItem[];
  readonly pending: () => readonly TaskItem[];
  readonly blocked: () => readonly TaskItem[];
  readonly inProgress: () => readonly TaskItem[];
  readonly completed: () => readonly TaskResult[];
  readonly failed: () => readonly TaskItem[];
  readonly unreachable: () => readonly TaskItem[];
  readonly dependentsOf: (taskId: TaskItemId) => readonly TaskItem[];
  readonly all: () => readonly TaskItem[];
  readonly size: () => number;
}

/**
 * TaskBoard contract — persistent task coordination for multi-agent swarms.
 *
 * A TaskBoard maintains a DAG of tasks with dependency tracking,
 * assignment, completion, failure/retry, kill, and board-level queries.
 *
 * Exception: branded type constructor (taskItemId) is permitted in L0
 * as a zero-logic identity cast for type safety.
 * Exception: DEFAULT_TASK_BOARD_CONFIG is a pure readonly data constant
 * derived from L0 type definitions.
 * Exception: isTerminalTaskStatus, isValidTransition, VALID_TASK_TRANSITIONS
 * are pure functions/constants operating only on L0 types.
 */

import type { JsonObject } from "./common.js";
import type { DelegationGrant } from "./delegation.js";
import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { ArtifactRef, DecisionRecord } from "./handoff.js";

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
// Task status — 5-state lifecycle
// ---------------------------------------------------------------------------

/**
 * Task lifecycle states.
 *
 * Valid transitions:
 *   pending     → in_progress, killed
 *   in_progress → completed, failed, killed
 *   completed   → (terminal)
 *   failed      → (terminal)
 *   killed      → (terminal)
 *
 * `failed` = task attempted and errored (potentially retryable by the board).
 * `killed` = externally cancelled (never retryable).
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "killed";

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

/**
 * Valid state transitions as a const map.
 * Terminal states (completed, failed, killed) have empty sets.
 */
export const VALID_TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> =
  Object.freeze({
    pending: new Set<TaskStatus>(["in_progress", "killed"]),
    in_progress: new Set<TaskStatus>(["completed", "failed", "killed"]),
    completed: new Set<TaskStatus>(),
    failed: new Set<TaskStatus>(),
    killed: new Set<TaskStatus>(),
  });

/**
 * True when a task is in a terminal state and will not transition further.
 * Used to guard against injecting messages into dead tasks, evicting
 * finished tasks, and orphan-cleanup paths.
 *
 * Exception: pure function operating only on L0 types, permitted in L0.
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

/**
 * Runtime check for whether a state transition is valid.
 *
 * Exception: pure function operating only on L0 types, permitted in L0.
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TASK_TRANSITIONS[from].has(to);
}

// ---------------------------------------------------------------------------
// Task — a unit of work on the board (evolved from TaskItem)
// ---------------------------------------------------------------------------

/** Input shape for adding a task to the board. */
export interface TaskInput {
  readonly id: TaskItemId;
  /** Short title for lists/dashboards. Defaults to description if omitted. */
  readonly subject?: string | undefined;
  readonly description: string;
  readonly dependencies?: readonly TaskItemId[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** A task on the board with full state. */
export interface Task {
  readonly id: TaskItemId;
  readonly subject: string;
  readonly description: string;
  readonly dependencies: readonly TaskItemId[];
  readonly status: TaskStatus;
  readonly assignedTo?: AgentId | undefined;
  readonly error?: KoiError | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Scheduling hints — separated from the core task model.
 * Owned by scheduling/orchestration consumers, not the task board.
 */
export interface TaskSchedulingHints {
  readonly priority?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retries?: number | undefined;
  /** Delegation hint: "self" = current agent, "spawn" = delegate to worker. */
  readonly delegation?: "self" | "spawn" | undefined;
  /** Agent type hint for worker selection when delegation = "spawn". */
  readonly agentType?: string | undefined;
}

/** Result produced by a completed task. */
export interface TaskResult {
  readonly taskId: TaskItemId;
  readonly output: string;
  readonly durationMs: number;
  readonly results?: JsonObject | undefined;
  readonly artifacts?: readonly ArtifactRef[] | undefined;
  readonly decisions?: readonly DecisionRecord[] | undefined;
  readonly warnings?: readonly string[] | undefined;
  readonly delegation?: DelegationGrant | undefined;
  readonly workerId?: AgentId | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Patch fields for updating a pending or in-progress task. */
export interface TaskPatch {
  readonly subject?: string | undefined;
  readonly description?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Board events (discriminated union)
// ---------------------------------------------------------------------------

export type TaskBoardEvent =
  | { readonly kind: "task:added"; readonly task: Task }
  | { readonly kind: "task:assigned"; readonly taskId: TaskItemId; readonly agentId: AgentId }
  | { readonly kind: "task:completed"; readonly taskId: TaskItemId; readonly result: TaskResult }
  | { readonly kind: "task:failed"; readonly taskId: TaskItemId; readonly error: KoiError }
  | { readonly kind: "task:retried"; readonly taskId: TaskItemId; readonly retries: number }
  | { readonly kind: "task:killed"; readonly taskId: TaskItemId }
  | {
      readonly kind: "task:unreachable";
      readonly taskId: TaskItemId;
      readonly blockedBy: TaskItemId;
    };

// ---------------------------------------------------------------------------
// Board snapshot (serialization)
// ---------------------------------------------------------------------------

export interface TaskBoardSnapshot {
  readonly items: readonly Task[];
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
// Reconciler types
// ---------------------------------------------------------------------------

/** Action returned by a TaskReconciler check. */
export type TaskReconcileAction =
  | { readonly kind: "cancel"; readonly taskId: TaskItemId; readonly reason: string }
  | { readonly kind: "update"; readonly taskId: TaskItemId; readonly description: string }
  | { readonly kind: "add"; readonly task: TaskInput };

/** External reconciler that checks board state against an outside source of truth. */
export interface TaskReconciler {
  readonly check: (board: TaskBoardSnapshot) => Promise<readonly TaskReconcileAction[]>;
}

// ---------------------------------------------------------------------------
// TaskBoard interface
// ---------------------------------------------------------------------------

export interface TaskBoard {
  // Mutations — return a new board or an error
  readonly add: (input: TaskInput) => Result<TaskBoard, KoiError>;
  readonly addAll: (inputs: readonly TaskInput[]) => Result<TaskBoard, KoiError>;
  readonly assign: (taskId: TaskItemId, agentId: AgentId) => Result<TaskBoard, KoiError>;
  readonly complete: (taskId: TaskItemId, result: TaskResult) => Result<TaskBoard, KoiError>;
  readonly fail: (taskId: TaskItemId, error: KoiError) => Result<TaskBoard, KoiError>;
  readonly kill: (taskId: TaskItemId) => Result<TaskBoard, KoiError>;
  readonly update: (taskId: TaskItemId, patch: TaskPatch) => Result<TaskBoard, KoiError>;

  // Queries
  readonly result: (taskId: TaskItemId) => TaskResult | undefined;
  readonly get: (taskId: TaskItemId) => Task | undefined;
  readonly ready: () => readonly Task[];
  readonly pending: () => readonly Task[];
  readonly blocked: () => readonly Task[];
  readonly inProgress: () => readonly Task[];
  readonly completed: () => readonly TaskResult[];
  readonly failed: () => readonly Task[];
  readonly killed: () => readonly Task[];
  readonly unreachable: () => readonly Task[];
  readonly dependentsOf: (taskId: TaskItemId) => readonly Task[];
  readonly all: () => readonly Task[];
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Backward compatibility aliases (deprecated — remove in next major)
// ---------------------------------------------------------------------------

/** @deprecated Use `Task` instead. */
export type TaskItem = Task;
/** @deprecated Use `TaskStatus` instead. */
export type TaskItemStatus = TaskStatus;
/** @deprecated Use `TaskInput` instead. */
export type TaskItemInput = TaskInput;
/** @deprecated Use `TaskPatch` instead. */
export type TaskItemPatch = TaskPatch;

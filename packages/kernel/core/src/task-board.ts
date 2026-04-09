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

import type { ChangeNotifier } from "./change-notifier.js";
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
  /**
   * Present-continuous description shown in spinner while in_progress
   * (e.g. "Reviewing auth module"). Cleared by the board on terminal transitions.
   */
  readonly activeForm?: string | undefined;
}

/** A task on the board with full state. */
export interface Task {
  readonly id: TaskItemId;
  readonly subject: string;
  readonly description: string;
  readonly dependencies: readonly TaskItemId[];
  readonly status: TaskStatus;
  readonly assignedTo?: AgentId | undefined;
  /**
   * Present-continuous description shown in spinner while in_progress
   * (e.g. "Reviewing auth module"). Cleared by the board on terminal transitions.
   */
  readonly activeForm?: string | undefined;
  /** Board-managed retry count. Incremented by the board on retryable failure. */
  readonly retries: number;
  /** Board-managed version. Incremented on every mutation for optimistic concurrency. */
  readonly version: number;
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
  /**
   * Update the present-continuous spinner text.
   * Pass `undefined` explicitly to clear the current value.
   */
  readonly activeForm?: string | undefined;
}

// ---------------------------------------------------------------------------
// Board events (discriminated union)
// ---------------------------------------------------------------------------

export type TaskBoardEvent =
  | { readonly kind: "task:added"; readonly task: Task }
  | { readonly kind: "task:assigned"; readonly taskId: TaskItemId; readonly agentId: AgentId }
  | { readonly kind: "task:unassigned"; readonly taskId: TaskItemId }
  | { readonly kind: "task:completed"; readonly taskId: TaskItemId; readonly result: TaskResult }
  | { readonly kind: "task:failed"; readonly taskId: TaskItemId; readonly error: KoiError }
  | { readonly kind: "task:retried"; readonly taskId: TaskItemId; readonly retries: number }
  | {
      readonly kind: "task:killed";
      readonly taskId: TaskItemId;
      /** Pre-transition status — "pending" or "in_progress". */
      readonly previousStatus: TaskStatus;
    }
  | {
      readonly kind: "task:unreachable";
      readonly taskId: TaskItemId;
      readonly blockedBy: TaskItemId;
    }
  | {
      /** Emitted when a task's subject, description, or activeForm is patched. */
      readonly kind: "task:updated";
      readonly taskId: TaskItemId;
      readonly patch: TaskPatch;
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
  /**
   * Max in-progress tasks per assignee. undefined = unlimited.
   * Enforced per board instance — multiple boards sharing a store
   * do not coordinate on this limit.
   */
  readonly maxInProgressPerOwner?: number | undefined;
  readonly onEvent?: ((event: TaskBoardEvent, board: TaskBoard) => void) | undefined;
  /** Called when onEvent throws. Errors still swallowed — mutations never fail from handlers. */
  readonly onEventError?: ((error: unknown, event: TaskBoardEvent) => void) | undefined;
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
  /**
   * Atomically unassign an in_progress task, resetting it to pending.
   *
   * Preserves the task ID (unlike kill+add recovery patterns).
   * Fails if the task is not currently in_progress.
   * Use this for crash-safe coordinator restart: unassign each orphaned task
   * so it becomes schedulable again without creating duplicate live tasks.
   */
  readonly unassign: (taskId: TaskItemId) => Result<TaskBoard, KoiError>;
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
// TaskBoardStore — pluggable persistence backend for task board items
// ---------------------------------------------------------------------------

/** Filter criteria for listing tasks. */
export interface TaskBoardStoreFilter {
  readonly status?: TaskStatus | undefined;
  readonly assignedTo?: AgentId | undefined;
}

/** Events emitted by the task board store on mutations. */
export type TaskBoardStoreEvent =
  | { readonly kind: "put"; readonly item: Task }
  | { readonly kind: "deleted"; readonly id: TaskItemId };

/** Task board store change notifier (specialized ChangeNotifier). */
export type TaskBoardStoreNotifier = ChangeNotifier<TaskBoardStoreEvent>;

/**
 * Pluggable persistence backend for task board items.
 *
 * **Single-writer**: each store instance is designed for use by one writer
 * (typically one `ManagedTaskBoard`). Multi-process coordination requires
 * an external lock or a store with atomic conditional writes (e.g., Nexus).
 *
 * Implementations may be sync (in-memory) or async (file-based, network).
 * Callers must always `await` the result — `await` on a non-Promise is a no-op.
 *
 * ID generation is owned by the store (monotonic integer counter with high
 * water mark that survives deletion and restart).
 */
export interface TaskBoardStore extends AsyncDisposable {
  /** Retrieve a task by ID. Returns undefined if not found. */
  readonly get: (id: TaskItemId) => Task | undefined | Promise<Task | undefined>;
  /**
   * Persist a task. Throws if `item.version` is ≤ the stored task's version
   * (stale-write guard). New tasks (no existing entry) are always accepted.
   * This is a single-writer safety net, not multi-process CAS.
   */
  readonly put: (item: Task) => void | Promise<void>;
  /** Delete a task by ID. No-op if not found. */
  readonly delete: (id: TaskItemId) => void | Promise<void>;
  /** List tasks, optionally filtered by status or assignee. */
  readonly list: (filter?: TaskBoardStoreFilter) => readonly Task[] | Promise<readonly Task[]>;
  /** Generate the next unique task item ID. Monotonic, never reuses after deletion. */
  readonly nextId: () => TaskItemId | Promise<TaskItemId>;
  /** Subscribe to store mutation events. Returns unsubscribe function. */
  readonly watch: (listener: (event: TaskBoardStoreEvent) => void) => () => void;
  /** Clear all tasks. High water mark is preserved (IDs are never reused). */
  readonly reset: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// ManagedTaskBoard — interface for the persistence-backed task board
// ---------------------------------------------------------------------------

/**
 * A task board backed by persistent storage.
 *
 * Wraps an immutable TaskBoard with a TaskBoardStore, providing the same
 * mutation surface with automatic persistence and async serialization.
 *
 * Defined in L0 so that L2 consumers (e.g. @koi/task-tools) can depend on
 * the interface without importing the L2 implementation (@koi/tasks).
 *
 * Exception: all methods return Promises (I/O-bound operations).
 */
export interface ManagedTaskBoard extends AsyncDisposable {
  /** Current immutable board snapshot. */
  readonly snapshot: () => TaskBoard;
  /** Generate the next unique task item ID. Monotonic, never reuses after deletion. */
  readonly nextId: () => Promise<TaskItemId>;
  /** Add a task — validates via board, persists to store. */
  readonly add: (input: TaskInput) => Promise<Result<TaskBoard, KoiError>>;
  /** Add multiple tasks atomically — validates via board, persists to store. */
  readonly addAll: (inputs: readonly TaskInput[]) => Promise<Result<TaskBoard, KoiError>>;
  /** Assign a task to an agent — validates via board, persists to store. */
  readonly assign: (taskId: TaskItemId, agentId: AgentId) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Unassign an in_progress task, atomically resetting it to pending.
   *
   * Preserves the task ID. Use during coordinator restart to reset orphaned
   * child tasks to schedulable without killing/duplicating them.
   */
  readonly unassign: (taskId: TaskItemId) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Atomically check that no task is already `in_progress` and assign `taskId`
   * to `agentId` — all within the single-writer lock.
   *
   * Use this instead of `assign()` when enforcing the one-active-task invariant,
   * because a snapshot read + separate `assign()` call is a TOCTOU race.
   */
  readonly startTask: (
    taskId: TaskItemId,
    agentId: AgentId,
  ) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Returns `true` when completed `TaskResult` payloads are persisted to disk and
   * will survive a process restart. Returns `false` when results are in-memory only.
   *
   * Tools that expose task output (e.g. `task_output`) should check this before
   * allowing task completion, to prevent the silent data-loss path where a task
   * shows as `completed` but its output is permanently gone after a restart.
   */
  readonly hasResultPersistence: () => boolean;
  /** Complete a task — validates via board, persists to store. */
  readonly complete: (
    taskId: TaskItemId,
    result: TaskResult,
  ) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Atomically verify `taskId` is assigned to `agentId` and complete it.
   * Use instead of `complete()` to prevent cross-agent completion races.
   */
  readonly completeOwnedTask: (
    taskId: TaskItemId,
    agentId: AgentId,
    result: TaskResult,
  ) => Promise<Result<TaskBoard, KoiError>>;
  /** Fail a task — validates via board, persists to store. */
  readonly fail: (taskId: TaskItemId, error: KoiError) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Atomically verify `taskId` is assigned to `agentId` and fail it.
   * Use instead of `fail()` to prevent cross-agent failure races.
   */
  readonly failOwnedTask: (
    taskId: TaskItemId,
    agentId: AgentId,
    error: KoiError,
  ) => Promise<Result<TaskBoard, KoiError>>;
  /** Kill a task — validates via board, persists to store. */
  readonly kill: (taskId: TaskItemId) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Atomically verify `taskId` is still `pending`, optionally verify
   * `expectedKind` matches `task.metadata.kind`, apply `metadata` patch,
   * and kill the task — all under one lock.
   *
   * Use for unsupported-kind rejection: avoids TOCTOU between snapshot
   * read and kill, refuses to cancel in_progress tasks, and persists
   * the rejection reason atomically.
   *
   * Returns CONFLICT if the task is not pending or kind doesn't match.
   */
  readonly killIfPending: (
    taskId: TaskItemId,
    options?: {
      readonly expectedKind?: string | undefined;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Atomically verify `taskId` is assigned to `agentId` and kill it.
   * Use instead of `kill()` to prevent cross-agent cancellation races.
   */
  readonly killOwnedTask: (
    taskId: TaskItemId,
    agentId: AgentId,
  ) => Promise<Result<TaskBoard, KoiError>>;
  /** Update task metadata — validates via board, persists to store. */
  readonly update: (taskId: TaskItemId, patch: TaskPatch) => Promise<Result<TaskBoard, KoiError>>;
  /**
   * Atomically verify `taskId` is either unassigned or assigned to `agentId`,
   * then apply a metadata patch. Rejects cross-agent metadata writes on in_progress tasks.
   */
  readonly updateOwned: (
    taskId: TaskItemId,
    agentId: AgentId,
    patch: TaskPatch,
  ) => Promise<Result<TaskBoard, KoiError>>;
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

// ---------------------------------------------------------------------------
// Task kind name — runtime task type discriminator
// ---------------------------------------------------------------------------

/**
 * Canonical list of task kind names — the SINGLE source of truth.
 * `TaskKindName` is derived from this tuple, so adding a kind here
 * automatically updates both the type and the runtime validation.
 *
 * Exception: pure readonly data constant derived from L0 types, permitted in L0.
 */
const _TASK_KIND_NAMES = [
  "local_shell",
  "local_agent",
  "remote_agent",
  "in_process_teammate",
  "dream",
] as const;

/**
 * Canonical frozen list of task kind names — the SINGLE source of truth.
 * `TaskKindName` is derived from this tuple, so adding a kind here
 * automatically updates both the type and the runtime validation.
 * Frozen: push/splice/assignment all throw in strict mode.
 *
 * Exception: pure readonly data constant derived from L0 types, permitted in L0.
 */
export const TASK_KIND_NAMES: typeof _TASK_KIND_NAMES = Object.freeze(_TASK_KIND_NAMES);

/**
 * Runtime task kind discriminator. Stored in `task.metadata.kind` to
 * identify which lifecycle implementation manages a given task.
 *
 * Derived from `TASK_KIND_NAMES` — adding a new kind to the tuple
 * automatically widens this union.
 */
export type TaskKindName = (typeof TASK_KIND_NAMES)[number];

// ---------------------------------------------------------------------------
// Task kind name — runtime validation
// ---------------------------------------------------------------------------

/**
 * Private lookup set for O(1) membership checks. Module-private so no
 * consumer can mutate it. Built from TASK_KIND_NAMES (single source of truth).
 */
const _kindSet: ReadonlySet<string> = new Set<string>(TASK_KIND_NAMES);

/**
 * Runtime set of all valid TaskKindName values — backward-compatible
 * `ReadonlySet<string>` API. Exposed as a new Set copy so mutations to the
 * export cannot affect the private _kindSet used by isValidTaskKindName().
 *
 * Exception: pure readonly data constant derived from L0 types, permitted in L0.
 */
export const VALID_TASK_KIND_NAMES: ReadonlySet<string> = new Set<string>(TASK_KIND_NAMES);

/**
 * Runtime guard for TaskKindName — narrows an arbitrary string to the
 * closed union type. Use at system boundaries where `task.metadata.kind`
 * (an untyped string) needs validation before being treated as a TaskKindName.
 * Uses the private _kindSet — mutations to the exported VALID_TASK_KIND_NAMES
 * cannot affect this guard.
 *
 * Exception: pure function operating only on L0 types, permitted in L0.
 */
export function isValidTaskKindName(value: string): value is TaskKindName {
  return _kindSet.has(value);
}

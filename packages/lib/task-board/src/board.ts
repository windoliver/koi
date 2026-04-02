/**
 * createTaskBoard — immutable TaskBoard implementation with DAG validation.
 *
 * 5-state lifecycle: pending → in_progress → completed | failed | killed
 * Eager unreachable tracking via internal Set<TaskItemId>.
 * Try/catch event emission (consumer errors cannot crash mutations).
 */

import type {
  AgentId,
  KoiError,
  Result,
  Task,
  TaskBoard,
  TaskBoardConfig,
  TaskBoardEvent,
  TaskBoardSnapshot,
  TaskInput,
  TaskItemId,
  TaskPatch,
  TaskResult,
  TaskStatus,
} from "@koi/core";
import { DEFAULT_TASK_BOARD_CONFIG, isTerminalTaskStatus, isValidTransition } from "@koi/core";
import { detectCycle } from "./dag.js";

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

function conflictError(id: TaskItemId): KoiError {
  return {
    code: "CONFLICT",
    message: `Task already exists: ${id}`,
    retryable: false,
    context: { resourceId: id },
  };
}

function notFoundError(id: TaskItemId): KoiError {
  return {
    code: "NOT_FOUND",
    message: `Task not found: ${id}`,
    retryable: false,
    context: { resourceId: id },
  };
}

function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: false,
  };
}

function ok(board: TaskBoard): Result<TaskBoard, KoiError> {
  return { ok: true, value: board };
}

function fail(error: KoiError): Result<TaskBoard, KoiError> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isReady(task: Task, items: ReadonlyMap<TaskItemId, Task>): boolean {
  if (task.status !== "pending") return false;
  return task.dependencies.every((dep) => {
    const depTask = items.get(dep);
    return depTask !== undefined && depTask.status === "completed";
  });
}

function inputToTask(input: TaskInput, now: number): Task {
  return {
    id: input.id,
    subject: input.subject ?? input.description,
    description: input.description,
    dependencies: input.dependencies ?? [],
    status: "pending",
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Safe event emission — consumer errors cannot crash board mutations.
 * Follows CC pattern: "task mutations must not fail due to notification issues."
 */
function emit(config: TaskBoardConfig, event: TaskBoardEvent): void {
  if (config.onEvent !== undefined) {
    try {
      config.onEvent(event);
    } catch {
      // Swallow consumer errors — mutations must never fail due to event handlers.
    }
  }
}

/**
 * Compute the initial unreachable set from board state.
 * A task is unreachable if it is pending and any transitive dependency
 * is in a terminal non-completed state (failed or killed).
 */
function computeUnreachableSet(items: ReadonlyMap<TaskItemId, Task>): ReadonlySet<TaskItemId> {
  const unreachable = new Set<TaskItemId>();
  // Cache: whether a task has a terminal-non-completed ancestor
  const cache = new Map<TaskItemId, boolean>();

  function hasDeadAncestor(taskId: TaskItemId, visiting: Set<TaskItemId>): boolean {
    const cached = cache.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return false; // cycle guard
    visiting.add(taskId);

    const task = items.get(taskId);
    if (task === undefined) {
      cache.set(taskId, false);
      return false;
    }

    for (const dep of task.dependencies) {
      const depTask = items.get(dep);
      if (depTask === undefined) continue;
      // Direct dead dependency
      if (depTask.status === "failed" || depTask.status === "killed") {
        cache.set(taskId, true);
        return true;
      }
      // Transitive dead dependency
      if (hasDeadAncestor(dep, visiting)) {
        cache.set(taskId, true);
        return true;
      }
    }

    cache.set(taskId, false);
    return false;
  }

  for (const [id, task] of items) {
    if (task.status === "pending" && hasDeadAncestor(id, new Set())) {
      unreachable.add(id);
    }
  }

  return unreachable;
}

/**
 * Find all pending tasks downstream of the given task that are newly unreachable.
 * Used for incremental unreachable tracking after fail/kill.
 */
function findNewlyUnreachable(
  taskId: TaskItemId,
  items: ReadonlyMap<TaskItemId, Task>,
  existingUnreachable: ReadonlySet<TaskItemId>,
): readonly TaskItemId[] {
  const newlyUnreachable: TaskItemId[] = [];
  const visited = new Set<TaskItemId>();

  function traverse(current: TaskItemId): void {
    for (const [id, task] of items) {
      if (visited.has(id)) continue;
      if (!task.dependencies.includes(current)) continue;
      visited.add(id);
      if (task.status === "pending" && !existingUnreachable.has(id)) {
        newlyUnreachable.push(id);
      }
      // Continue traversal to find transitive dependents
      traverse(id);
    }
  }

  traverse(taskId);
  return newlyUnreachable;
}

// ---------------------------------------------------------------------------
// Board factory
// ---------------------------------------------------------------------------

function createBoardFromState(
  items: ReadonlyMap<TaskItemId, Task>,
  results: ReadonlyMap<TaskItemId, TaskResult>,
  unreachableIds: ReadonlySet<TaskItemId>,
  config: TaskBoardConfig,
): TaskBoard {
  const maxRetries = config.maxRetries ?? DEFAULT_TASK_BOARD_CONFIG.maxRetries ?? 3;
  const now = (): number => Date.now();

  function transitionTask(
    taskId: TaskItemId,
    to: TaskStatus,
    patch?: Partial<Pick<Task, "assignedTo" | "error">>,
  ): Result<{ readonly task: Task; readonly items: ReadonlyMap<TaskItemId, Task> }, KoiError> {
    const task = items.get(taskId);
    if (task === undefined) {
      return { ok: false, error: notFoundError(taskId) };
    }
    if (!isValidTransition(task.status, to)) {
      return {
        ok: false,
        error: validationError(
          `Cannot transition task ${taskId}: '${task.status}' → '${to}' is not a valid transition`,
        ),
      };
    }
    const updated: Task = {
      ...task,
      status: to,
      updatedAt: now(),
      ...(patch ?? {}),
    };
    const newItems = new Map(items);
    newItems.set(taskId, updated);
    return { ok: true, value: { task: updated, items: newItems } };
  }

  const board: TaskBoard = {
    add(input: TaskInput): Result<TaskBoard, KoiError> {
      if (items.has(input.id)) {
        return fail(conflictError(input.id));
      }
      const deps = input.dependencies ?? [];
      if (deps.includes(input.id)) {
        return fail(validationError(`Cycle detected: ${input.id} → ${input.id}`));
      }
      for (const dep of deps) {
        if (!items.has(dep)) {
          return fail(notFoundError(dep));
        }
      }
      const cycle = detectCycle(items, deps, input.id);
      if (cycle !== undefined) {
        return fail(validationError(`Cycle detected: ${cycle.join(" → ")}`));
      }
      const newTask = inputToTask(input, now());
      const newItems = new Map(items);
      newItems.set(input.id, newTask);

      // Check if new task is immediately unreachable
      const newUnreachable = new Set(unreachableIds);
      const hasDeadDep = deps.some((dep) => {
        const depTask = items.get(dep);
        return (
          depTask !== undefined && (depTask.status === "failed" || depTask.status === "killed")
        );
      });
      const hasUnreachableDep = deps.some((dep) => unreachableIds.has(dep));
      if (hasDeadDep || hasUnreachableDep) {
        newUnreachable.add(input.id);
      }

      const newBoard = createBoardFromState(newItems, results, newUnreachable, config);
      emit(config, { kind: "task:added", task: newTask });
      if (newUnreachable.has(input.id)) {
        const blockingDep = deps.find((dep) => {
          const depTask = items.get(dep);
          return (
            (depTask !== undefined &&
              (depTask.status === "failed" || depTask.status === "killed")) ||
            unreachableIds.has(dep)
          );
        });
        if (blockingDep !== undefined) {
          emit(config, { kind: "task:unreachable", taskId: input.id, blockedBy: blockingDep });
        }
      }
      return ok(newBoard);
    },

    addAll(inputs: readonly TaskInput[]): Result<TaskBoard, KoiError> {
      const newItems = new Map(items);
      const newEntries: Task[] = [];
      const ts = now();

      for (const input of inputs) {
        if (newItems.has(input.id)) {
          return fail(conflictError(input.id));
        }
        const entry = inputToTask(input, ts);
        newEntries.push(entry);
        newItems.set(input.id, entry);
      }

      for (const entry of newEntries) {
        for (const dep of entry.dependencies) {
          if (!newItems.has(dep)) {
            return fail(notFoundError(dep));
          }
        }
        const cycle = detectCycle(newItems, entry.dependencies, entry.id);
        if (cycle !== undefined) {
          return fail(validationError(`Cycle detected: ${cycle.join(" → ")}`));
        }
      }

      // Recompute unreachable for new board state
      const newUnreachable = computeUnreachableSet(newItems);
      const newBoard = createBoardFromState(newItems, results, newUnreachable, config);
      for (const entry of newEntries) {
        emit(config, { kind: "task:added", task: entry });
      }
      return ok(newBoard);
    },

    assign(taskId: TaskItemId, agentId: AgentId): Result<TaskBoard, KoiError> {
      const task = items.get(taskId);
      if (task === undefined) {
        return fail(notFoundError(taskId));
      }
      if (task.status !== "pending") {
        return fail(
          validationError(
            `Cannot assign task ${taskId}: status is '${task.status}', expected 'pending'`,
          ),
        );
      }
      if (!isReady(task, items)) {
        return fail(validationError(`Cannot assign task ${taskId}: dependencies not satisfied`));
      }
      const result = transitionTask(taskId, "in_progress", { assignedTo: agentId });
      if (!result.ok) return { ok: false, error: result.error };
      const newBoard = createBoardFromState(result.value.items, results, unreachableIds, config);
      emit(config, { kind: "task:assigned", taskId, agentId });
      return ok(newBoard);
    },

    complete(taskId: TaskItemId, taskResult: TaskResult): Result<TaskBoard, KoiError> {
      if (taskResult.taskId !== taskId) {
        return fail(
          validationError(
            `Result taskId '${taskResult.taskId}' does not match completed taskId '${taskId}'`,
          ),
        );
      }
      const result = transitionTask(taskId, "completed");
      if (!result.ok) return { ok: false, error: result.error };
      const newResults = new Map(results);
      newResults.set(taskId, taskResult);
      const newBoard = createBoardFromState(result.value.items, newResults, unreachableIds, config);
      emit(config, { kind: "task:completed", taskId, result: taskResult });
      return ok(newBoard);
    },

    fail(taskId: TaskItemId, error: KoiError): Result<TaskBoard, KoiError> {
      const task = items.get(taskId);
      if (task === undefined) {
        return fail(notFoundError(taskId));
      }

      // Retry logic: check if we can retry before transitioning
      const retries = (task.metadata?.retries as number | undefined) ?? 0;
      const taskMaxRetries = (task.metadata?.maxRetries as number | undefined) ?? maxRetries;
      const canRetry = error.retryable === true && retries < taskMaxRetries;

      if (canRetry) {
        // Retry: back to pending with incremented retry count
        const updated: Task = {
          ...task,
          status: "pending",
          assignedTo: undefined,
          error,
          updatedAt: now(),
          metadata: {
            ...task.metadata,
            retries: retries + 1,
            maxRetries: taskMaxRetries,
          },
        };
        const newItems = new Map(items);
        newItems.set(taskId, updated);
        const newBoard = createBoardFromState(newItems, results, unreachableIds, config);
        emit(config, { kind: "task:retried", taskId, retries: retries + 1 });
        return ok(newBoard);
      }

      // Terminal failure
      const result = transitionTask(taskId, "failed", { assignedTo: undefined, error });
      if (!result.ok) return { ok: false, error: result.error };

      // Eager unreachable tracking: find newly unreachable downstream tasks
      const newlyUnreachable = findNewlyUnreachable(taskId, result.value.items, unreachableIds);
      const newUnreachable = new Set(unreachableIds);
      for (const id of newlyUnreachable) {
        newUnreachable.add(id);
      }

      const newBoard = createBoardFromState(result.value.items, results, newUnreachable, config);
      emit(config, { kind: "task:failed", taskId, error });
      for (const id of newlyUnreachable) {
        emit(config, { kind: "task:unreachable", taskId: id, blockedBy: taskId });
      }
      return ok(newBoard);
    },

    kill(taskId: TaskItemId): Result<TaskBoard, KoiError> {
      const result = transitionTask(taskId, "killed");
      if (!result.ok) return { ok: false, error: result.error };

      // Eager unreachable tracking: find newly unreachable downstream tasks
      const newlyUnreachable = findNewlyUnreachable(taskId, result.value.items, unreachableIds);
      const newUnreachable = new Set(unreachableIds);
      for (const id of newlyUnreachable) {
        newUnreachable.add(id);
      }

      const newBoard = createBoardFromState(result.value.items, results, newUnreachable, config);
      emit(config, { kind: "task:killed", taskId });
      for (const id of newlyUnreachable) {
        emit(config, { kind: "task:unreachable", taskId: id, blockedBy: taskId });
      }
      return ok(newBoard);
    },

    update(taskId: TaskItemId, patch: TaskPatch): Result<TaskBoard, KoiError> {
      const task = items.get(taskId);
      if (task === undefined) {
        return fail(notFoundError(taskId));
      }
      if (isTerminalTaskStatus(task.status)) {
        return fail(validationError(`Cannot update task ${taskId}: status is '${task.status}'`));
      }
      const updated: Task = {
        ...task,
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        updatedAt: now(),
      };
      const newItems = new Map(items);
      newItems.set(taskId, updated);
      return ok(createBoardFromState(newItems, results, unreachableIds, config));
    },

    result(taskId: TaskItemId): TaskResult | undefined {
      return results.get(taskId);
    },

    get(taskId: TaskItemId): Task | undefined {
      return items.get(taskId);
    },

    ready(): readonly Task[] {
      const readyTasks: Task[] = [];
      for (const [, task] of items) {
        if (isReady(task, items)) {
          readyTasks.push(task);
        }
      }
      return readyTasks;
    },

    pending(): readonly Task[] {
      const result: Task[] = [];
      for (const [, task] of items) {
        if (task.status === "pending") {
          result.push(task);
        }
      }
      return result;
    },

    blocked(): readonly Task[] {
      const result: Task[] = [];
      for (const [, task] of items) {
        if (task.status === "pending" && !isReady(task, items)) {
          result.push(task);
        }
      }
      return result;
    },

    inProgress(): readonly Task[] {
      const result: Task[] = [];
      for (const [, task] of items) {
        if (task.status === "in_progress") {
          result.push(task);
        }
      }
      return result;
    },

    completed(): readonly TaskResult[] {
      return [...results.values()];
    },

    failed(): readonly Task[] {
      const result: Task[] = [];
      for (const [, task] of items) {
        if (task.status === "failed") {
          result.push(task);
        }
      }
      return result;
    },

    killed(): readonly Task[] {
      const result: Task[] = [];
      for (const [, task] of items) {
        if (task.status === "killed") {
          result.push(task);
        }
      }
      return result;
    },

    unreachable(): readonly Task[] {
      // O(1) lookup via eager tracking
      const result: Task[] = [];
      for (const id of unreachableIds) {
        const task = items.get(id);
        if (task !== undefined && task.status === "pending") {
          result.push(task);
        }
      }
      return result;
    },

    dependentsOf(taskId: TaskItemId): readonly Task[] {
      const result: Task[] = [];
      for (const [, task] of items) {
        if (task.dependencies.includes(taskId)) {
          result.push(task);
        }
      }
      return result;
    },

    all(): readonly Task[] {
      return [...items.values()];
    },

    size(): number {
      return items.size;
    },
  };

  return board;
}

/**
 * Creates an immutable TaskBoard. Every mutation returns a new board.
 */
export function createTaskBoard(config?: TaskBoardConfig, initial?: TaskBoardSnapshot): TaskBoard {
  const resolvedConfig = config ?? DEFAULT_TASK_BOARD_CONFIG;

  if (initial !== undefined) {
    const items = new Map<TaskItemId, Task>();
    for (const item of initial.items) {
      // Backward compatibility: ensure new fields have defaults for old snapshots
      const task: Task = {
        ...item,
        subject: item.subject ?? "",
        createdAt: item.createdAt ?? 0,
        updatedAt: item.updatedAt ?? 0,
      };
      items.set(task.id, task);
    }
    const resultMap = new Map<TaskItemId, TaskResult>();
    for (const result of initial.results) {
      resultMap.set(result.taskId, result);
    }
    const unreachable = computeUnreachableSet(items);
    return createBoardFromState(items, resultMap, unreachable, resolvedConfig);
  }

  return createBoardFromState(
    new Map<TaskItemId, Task>(),
    new Map<TaskItemId, TaskResult>(),
    new Set<TaskItemId>(),
    resolvedConfig,
  );
}

/**
 * createTaskBoard — immutable TaskBoard implementation with DAG validation.
 */

import type {
  AgentId,
  KoiError,
  Result,
  TaskBoard,
  TaskBoardConfig,
  TaskBoardEvent,
  TaskBoardSnapshot,
  TaskItem,
  TaskItemId,
  TaskItemInput,
  TaskItemPatch,
  TaskResult,
} from "@koi/core";
import { DEFAULT_TASK_BOARD_CONFIG } from "@koi/core";
import { detectCycle } from "./dag.js";

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

function isReady(item: TaskItem, items: ReadonlyMap<TaskItemId, TaskItem>): boolean {
  if (item.status !== "pending") return false;
  return item.dependencies.every((dep) => {
    const depItem = items.get(dep);
    return depItem !== undefined && depItem.status === "completed";
  });
}

function inputToItem(input: TaskItemInput, defaultMaxRetries: number): TaskItem {
  return {
    id: input.id,
    description: input.description,
    dependencies: input.dependencies ?? [],
    priority: input.priority ?? 0,
    maxRetries: input.maxRetries ?? defaultMaxRetries,
    retries: 0,
    status: "pending",
    metadata: input.metadata,
    delegation: input.delegation,
    agentType: input.agentType,
  };
}

function emit(config: TaskBoardConfig, event: TaskBoardEvent): void {
  if (config.onEvent !== undefined) {
    config.onEvent(event);
  }
}

function hasFailedTransitiveDep(
  taskId: TaskItemId,
  items: ReadonlyMap<TaskItemId, TaskItem>,
  visited: Set<TaskItemId>,
): boolean {
  const item = items.get(taskId);
  if (item === undefined) return false;
  for (const dep of item.dependencies) {
    if (visited.has(dep)) continue;
    visited.add(dep);
    const depItem = items.get(dep);
    if (depItem === undefined) continue;
    if (depItem.status === "failed") return true;
    if (hasFailedTransitiveDep(dep, items, visited)) return true;
  }
  return false;
}

function createBoardFromState(
  items: ReadonlyMap<TaskItemId, TaskItem>,
  results: ReadonlyMap<TaskItemId, TaskResult>,
  config: TaskBoardConfig,
): TaskBoard {
  const defaultMaxRetries = config.maxRetries ?? DEFAULT_TASK_BOARD_CONFIG.maxRetries ?? 3;

  const board: TaskBoard = {
    add(input: TaskItemInput): Result<TaskBoard, KoiError> {
      if (items.has(input.id)) {
        return fail(conflictError(input.id));
      }
      const deps = input.dependencies ?? [];
      // Self-dependency is a cycle, check before deps-exist validation
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
      const newItem = inputToItem(input, defaultMaxRetries);
      const newItems = new Map(items);
      newItems.set(input.id, newItem);
      const newBoard = createBoardFromState(newItems, results, config);
      emit(config, { kind: "task:added", item: newItem });
      return ok(newBoard);
    },

    addAll(inputs: readonly TaskItemInput[]): Result<TaskBoard, KoiError> {
      // Build combined map (existing + new) for validation
      const newItems = new Map(items);
      const newEntries: TaskItem[] = [];

      for (const input of inputs) {
        if (newItems.has(input.id)) {
          return fail(conflictError(input.id));
        }
        const entry = inputToItem(input, defaultMaxRetries);
        newEntries.push(entry);
        newItems.set(input.id, entry);
      }

      // Validate deps and cycles against the combined map
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

      const newBoard = createBoardFromState(newItems, results, config);
      for (const entry of newEntries) {
        emit(config, { kind: "task:added", item: entry });
      }
      return ok(newBoard);
    },

    assign(taskId: TaskItemId, agentId: AgentId): Result<TaskBoard, KoiError> {
      const item = items.get(taskId);
      if (item === undefined) {
        return fail(notFoundError(taskId));
      }
      if (item.status !== "pending") {
        return fail(
          validationError(
            `Cannot assign task ${taskId}: status is '${item.status}', expected 'pending'`,
          ),
        );
      }
      if (!isReady(item, items)) {
        return fail(validationError(`Cannot assign task ${taskId}: dependencies not satisfied`));
      }
      const updated: TaskItem = { ...item, status: "assigned", assignedTo: agentId };
      const newItems = new Map(items);
      newItems.set(taskId, updated);
      const newBoard = createBoardFromState(newItems, results, config);
      emit(config, { kind: "task:assigned", taskId, agentId });
      return ok(newBoard);
    },

    complete(taskId: TaskItemId, result: TaskResult): Result<TaskBoard, KoiError> {
      const item = items.get(taskId);
      if (item === undefined) {
        return fail(notFoundError(taskId));
      }
      if (item.status !== "assigned") {
        return fail(
          validationError(
            `Cannot complete task ${taskId}: status is '${item.status}', expected 'assigned'`,
          ),
        );
      }
      const updated: TaskItem = { ...item, status: "completed" };
      const newItems = new Map(items);
      newItems.set(taskId, updated);
      const newResults = new Map(results);
      newResults.set(taskId, result);
      const newBoard = createBoardFromState(newItems, newResults, config);
      emit(config, { kind: "task:completed", taskId, result });
      return ok(newBoard);
    },

    fail(taskId: TaskItemId, error: KoiError): Result<TaskBoard, KoiError> {
      const item = items.get(taskId);
      if (item === undefined) {
        return fail(notFoundError(taskId));
      }
      const canRetry = error.retryable && item.retries + 1 < item.maxRetries;
      const updated: TaskItem = canRetry
        ? { ...item, status: "pending", retries: item.retries + 1, assignedTo: undefined, error }
        : { ...item, status: "failed", assignedTo: undefined, error };
      const newItems = new Map(items);
      newItems.set(taskId, updated);
      const newBoard = createBoardFromState(newItems, results, config);
      if (canRetry) {
        emit(config, { kind: "task:retried", taskId, retries: updated.retries });
      } else {
        emit(config, { kind: "task:failed", taskId, error });
      }
      return ok(newBoard);
    },

    update(taskId: TaskItemId, patch: TaskItemPatch): Result<TaskBoard, KoiError> {
      const item = items.get(taskId);
      if (item === undefined) {
        return fail(notFoundError(taskId));
      }
      if (item.status === "completed" || item.status === "failed") {
        return fail(validationError(`Cannot update task ${taskId}: status is '${item.status}'`));
      }
      const updated: TaskItem = {
        ...item,
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      };
      const newItems = new Map(items);
      newItems.set(taskId, updated);
      return ok(createBoardFromState(newItems, results, config));
    },

    result(taskId: TaskItemId): TaskResult | undefined {
      return results.get(taskId);
    },

    get(taskId: TaskItemId): TaskItem | undefined {
      return items.get(taskId);
    },

    ready(): readonly TaskItem[] {
      const readyItems: TaskItem[] = [];
      for (const [, item] of items) {
        if (isReady(item, items)) {
          readyItems.push(item);
        }
      }
      return readyItems.sort((a, b) => a.priority - b.priority);
    },

    pending(): readonly TaskItem[] {
      const result: TaskItem[] = [];
      for (const [, item] of items) {
        if (item.status === "pending") {
          result.push(item);
        }
      }
      return result;
    },

    blocked(): readonly TaskItem[] {
      const result: TaskItem[] = [];
      for (const [, item] of items) {
        if (item.status === "pending" && !isReady(item, items)) {
          result.push(item);
        }
      }
      return result;
    },

    inProgress(): readonly TaskItem[] {
      const result: TaskItem[] = [];
      for (const [, item] of items) {
        if (item.status === "assigned") {
          result.push(item);
        }
      }
      return result;
    },

    completed(): readonly TaskResult[] {
      return [...results.values()];
    },

    failed(): readonly TaskItem[] {
      const result: TaskItem[] = [];
      for (const [, item] of items) {
        if (item.status === "failed") {
          result.push(item);
        }
      }
      return result;
    },

    unreachable(): readonly TaskItem[] {
      const result: TaskItem[] = [];
      for (const [, item] of items) {
        if (item.status !== "pending") continue;
        if (hasFailedTransitiveDep(item.id, items, new Set<TaskItemId>())) {
          result.push(item);
        }
      }
      return result;
    },

    dependentsOf(taskId: TaskItemId): readonly TaskItem[] {
      const result: TaskItem[] = [];
      for (const [, item] of items) {
        if (item.dependencies.includes(taskId)) {
          result.push(item);
        }
      }
      return result;
    },

    all(): readonly TaskItem[] {
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
    const items = new Map<TaskItemId, TaskItem>();
    for (const item of initial.items) {
      items.set(item.id, item);
    }
    const results = new Map<TaskItemId, TaskResult>();
    for (const result of initial.results) {
      results.set(result.taskId, result);
    }
    return createBoardFromState(items, results, resolvedConfig);
  }

  return createBoardFromState(
    new Map<TaskItemId, TaskItem>(),
    new Map<TaskItemId, TaskResult>(),
    resolvedConfig,
  );
}

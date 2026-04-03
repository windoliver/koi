/**
 * In-memory TaskBoardStore implementation.
 *
 * Map-backed store with monotonic integer ID generation and high water mark.
 * Suitable for tests and short-lived agent sessions.
 */

import type { Task, TaskBoardStore, TaskBoardStoreEvent, TaskBoardStoreFilter, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createMemoryChangeNotifier } from "@koi/validation";
import { matchesFilter } from "./filter.js";

/**
 * Create an in-memory TaskBoardStore backed by a Map.
 *
 * - IDs are monotonic integers: `task_1`, `task_2`, etc.
 * - High water mark is never decremented (IDs are never reused).
 * - All operations are synchronous.
 */
export function createMemoryTaskBoardStore(): TaskBoardStore {
  const items = new Map<TaskItemId, Task>();
  const notifier = createMemoryChangeNotifier<TaskBoardStoreEvent>();
  let highWaterMark = 0;

  const get = (id: TaskItemId): Task | undefined => {
    return items.get(id);
  };

  const put = (item: Task): void => {
    // Stale-write guard: reject same or older version (single-writer safety net)
    const existing = items.get(item.id);
    if (existing !== undefined && existing.version >= item.version) {
      throw new Error(
        `Version conflict for task ${item.id}: stored version ${String(existing.version)} >= incoming version ${String(item.version)}`,
      );
    }
    items.set(item.id, item);
    notifier.notify({ kind: "put", item });
  };

  const del = (id: TaskItemId): void => {
    const existed = items.has(id);
    items.delete(id);
    if (existed) {
      notifier.notify({ kind: "deleted", id });
    }
  };

  const list = (filter?: TaskBoardStoreFilter): readonly Task[] => {
    const result: Task[] = [];
    for (const item of items.values()) {
      if (matchesFilter(item, filter)) result.push(item);
    }
    return result;
  };

  const nextId = (): TaskItemId => {
    highWaterMark += 1;
    return taskItemId(`task_${String(highWaterMark)}`);
  };

  const reset = (): void => {
    items.clear();
    // highWaterMark is intentionally NOT reset
  };

  const dispose = (): Promise<void> => {
    items.clear();
    return Promise.resolve();
  };

  return {
    get,
    put,
    delete: del,
    list,
    nextId,
    watch: notifier.subscribe,
    reset,
    [Symbol.asyncDispose]: dispose,
  };
}

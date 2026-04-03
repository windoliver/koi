/**
 * Shared filter logic for TaskBoardStore implementations.
 */

import type { Task, TaskBoardStoreFilter } from "@koi/core";

/** Returns true if the task matches the filter criteria. */
export function matchesFilter(item: Task, filter?: TaskBoardStoreFilter): boolean {
  if (filter?.status !== undefined && item.status !== filter.status) return false;
  if (filter?.assignedTo !== undefined && item.assignedTo !== filter.assignedTo) return false;
  return true;
}

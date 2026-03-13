/**
 * ReminderSource adapter for TaskBoardSnapshot — bridges @koi/long-running
 * task boards into the goal-reminder middleware.
 */

import type { TaskBoardSnapshot, TaskItemStatus } from "@koi/core";
import type { ReminderSource } from "@koi/middleware-goal";

export interface TaskBoardSourceConfig {
  readonly statusFilter?: readonly TaskItemStatus[];
  readonly includePriority?: boolean;
  readonly includeStatus?: boolean;
}

const DEFAULT_STATUS_FILTER: readonly TaskItemStatus[] = ["pending", "assigned"];

export function createTaskBoardSource(
  getSnapshot: () => TaskBoardSnapshot,
  config?: TaskBoardSourceConfig,
): ReminderSource {
  const statusFilter = config?.statusFilter ?? DEFAULT_STATUS_FILTER;
  const includePriority = config?.includePriority ?? false;
  const includeStatus = config?.includeStatus ?? true;

  return {
    kind: "tasks",
    provider: () => {
      const snapshot = getSnapshot();
      const filtered = snapshot.items.filter((item) => statusFilter.includes(item.status));
      return filtered.map((item) => {
        const parts: string[] = [];
        if (includeStatus) parts.push(`[${item.status}]`);
        if (includePriority) parts.push(`[P${String(item.priority)}]`);
        parts.push(item.description);
        return parts.join(" ");
      });
    },
  };
}

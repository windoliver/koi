/**
 * toTaskSummary — projects a full Task to the lean TaskSummary for list responses.
 *
 * Uses `board.blockedBy(taskId)` (cached per snapshot in @koi/task-board) instead
 * of walking dependencies inline. This drops repeated `task_list` polling cost
 * for the same snapshot from O(N×D) to amortized O(N).
 */

import type { Task, TaskBoard } from "@koi/core";
import type { TaskSummary } from "./types.js";

export function toTaskSummary(task: Task, board: TaskBoard): TaskSummary {
  const blockedBy = task.status === "pending" ? board.blockedBy(task.id) : undefined;
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
    ...(task.assignedTo !== undefined ? { assignedTo: task.assignedTo } : {}),
    dependencies: task.dependencies,
    ...(blockedBy !== undefined ? { blockedBy } : {}),
  };
}

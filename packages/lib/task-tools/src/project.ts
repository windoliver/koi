/**
 * toTaskSummary — projects a full Task to the lean TaskSummary for list responses.
 */

import type { Task, TaskBoard, TaskItemId } from "@koi/core";
import type { TaskSummary } from "./types.js";

/** Find the first dependency that is not yet completed (the blocking dep). */
function findBlockedBy(task: Task, board: TaskBoard): TaskItemId | undefined {
  for (const depId of task.dependencies) {
    const dep = board.get(depId);
    if (dep !== undefined && dep.status !== "completed") {
      return depId;
    }
  }
  return undefined;
}

export function toTaskSummary(task: Task, board: TaskBoard): TaskSummary {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
    ...(task.assignedTo !== undefined ? { assignedTo: task.assignedTo } : {}),
    dependencies: task.dependencies,
    ...(task.status === "pending" ? { blockedBy: findBlockedBy(task, board) } : {}),
  };
}

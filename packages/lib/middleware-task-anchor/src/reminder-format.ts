/**
 * Format a TaskBoard snapshot into the injected system-reminder text.
 */

import type { Task, TaskBoard, TaskStatus } from "@koi/core";

/** Status label shown inside the reminder checkbox. */
function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return "in_progress";
    case "failed":
      return "failed";
    case "killed":
      return "killed";
    case "pending":
      return " ";
  }
}

function formatTaskLine(task: Task): string {
  const subject = task.subject.length > 0 ? task.subject : task.description;
  return `- [${statusLabel(task.status)}] ${subject}`;
}

/** Format the live board into the reminder body. */
export function formatTaskList(board: TaskBoard): string {
  const tasks = board.all();
  if (tasks.length === 0) return "";
  const lines: string[] = [];
  for (const task of tasks) {
    lines.push(formatTaskLine(task));
  }
  return lines.join("\n");
}

/** Build the full `<system-reminder>` block for a populated board. */
export function buildTaskReminder(header: string, body: string): string {
  return [
    "<system-reminder>",
    `${header}:`,
    body,
    "Don't mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

/** Build the nudge block shown when the board is empty and tool activity has occurred. */
export function buildEmptyBoardNudge(): string {
  return [
    "<system-reminder>",
    "No tasks on the board. If this conversation involves multiple steps,",
    "call task_create to decompose the work before continuing.",
    "Don't mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

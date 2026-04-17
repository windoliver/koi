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

/** Max chars per task line before truncation. Keeps the reminder block bounded. */
const MAX_TASK_TEXT = 300;

/**
 * Neutralize task text before splicing into a privileged system-reminder block.
 * Task `subject` / `description` fields are model-controlled via `task_create`
 * and `task_update`, so raw text could terminate the wrapper or inject newlines
 * that look like new reminder directives.
 *
 * Order matters: escape `&` first so already-encoded payloads like
 * `&lt;/system-reminder&gt;` are escaped to `&amp;lt;/system-reminder&amp;gt;`
 * and cannot be interpreted as an escape of our own wrapper. Then neutralize
 * raw angle brackets and collapse line-breaks / tabs so the content is rendered
 * as single-line opaque data, not structural markup.
 */
export function sanitizeTaskText(raw: string): string {
  const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
  const escaped = oneLine.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.length > MAX_TASK_TEXT ? `${escaped.slice(0, MAX_TASK_TEXT)}…` : escaped;
}

/**
 * Character class that can safely appear in a reminder-rendered task ID
 * without breaking the `<system-reminder>` wrapper or splitting lines.
 * Covers the ID shapes every known board produces: monotonic (`task_42`),
 * UUID (`f47ac10b-...`), ULID (`01HX...`), hex hashes, namespaced IDs
 * (`ns:entity/42`), etc.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/**
 * Max chars per rendered task ID. Fits UUIDv4 (36), ULID (26), monotonic
 * IDs, and hex sha-512 (128) with ~1.5× headroom. The cap bounds reminder
 * size under pathological boards so idle/retry re-injection cannot blow the
 * provider context. Task boards SHOULD enforce a stricter policy at the
 * board boundary; this is defense in depth.
 */
const MAX_TASK_ID = 200;

/**
 * Normalize a task ID for inclusion in the reminder block.
 *
 * Strategy: lossless for safe IDs up to `MAX_TASK_ID` chars (common case —
 * the exact substring round-trips into `task_get` / `task_update`), escaped
 * for IDs containing structural characters that could terminate the
 * `<system-reminder>` wrapper or inject new directives. An ID that fails
 * the safety check is prefixed with `unsafe-id:` so the model sees an
 * unmistakable token it won't feed back into a tool. Over-length safe IDs
 * are truncated with `…`.
 */
function normalizeTaskId(id: string): string {
  if (SAFE_ID_PATTERN.test(id)) {
    return id.length > MAX_TASK_ID ? `${id.slice(0, MAX_TASK_ID)}…` : id;
  }
  const escaped = id
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const bounded = escaped.length > MAX_TASK_ID ? `${escaped.slice(0, MAX_TASK_ID)}…` : escaped;
  return `unsafe-id:${bounded}`;
}

function formatTaskLine(task: Task): string {
  const subject = task.subject.length > 0 ? task.subject : task.description;
  return `- [${statusLabel(task.status)}] ${normalizeTaskId(task.id)} — ${sanitizeTaskText(subject)}`;
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
    `${header} (internal IDs — do NOT echo them to the user):`,
    body,
    "Don't mention this reminder or the task IDs to the user.",
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

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

/**
 * Reminder render priority — actionable states first so they always land
 * inside the cap, with failed/killed ahead of completed so failure signals
 * survive truncation. Matches the intent of `task_list`: show the work that
 * needs attention first.
 */
const STATUS_ORDER: readonly TaskStatus[] = [
  "in_progress",
  "pending",
  "failed",
  "killed",
  "completed",
];

const KNOWN_STATUSES: ReadonlySet<string> = new Set(STATUS_ORDER);

/** Format the live board into the reminder body.
 *
 * Ordering: `in_progress` → `pending` → `failed` → `killed` → `completed`
 * (priority bucket + insertion order within each). Actionable tasks land
 * inside the cap first, then terminal history fills the remaining budget.
 *
 * Truncation policy (HARD global cap):
 *   - Total rendered lines never exceed `maxTasks + 1` (cap + overflow marker).
 *   - Priority order means terminal history is dropped FIRST, so the most
 *     actionable signal survives. Failed/killed come before completed within
 *     the terminal half so failure signals aren't buried.
 *   - Pathological boards with thousands of live tasks get paged: the cap
 *     drops excess live tasks into the overflow summary with per-status
 *     counts and a directive to call `task_list` for the full set.
 *   - A prompt-bloat risk takes precedence over full-visibility of every
 *     live task ID because the alternative (unbounded reminder) can exceed
 *     provider context windows and cause hard request failures.
 *
 * The overflow marker preserves per-status counts so the model retains the
 * signal that failures/killed/live tasks were hidden (not just completed).
 *
 * `maxTasks` of 0 or negative disables the cap entirely. */
export function formatTaskList(board: TaskBoard, maxTasks = 0): string {
  const tasks = board.all();
  if (tasks.length === 0) return "";

  // Priority-ordered view: actionable first, failures before completions.
  // Tasks with unknown statuses (version skew / corrupted store rows) are
  // appended at the end so they're never silently dropped from the reminder.
  const prioritized: Task[] = [];
  for (const status of STATUS_ORDER) {
    for (const task of tasks) {
      if (task.status === status) prioritized.push(task);
    }
  }
  for (const task of tasks) {
    if (!KNOWN_STATUSES.has(task.status)) prioritized.push(task);
  }

  const cap = maxTasks > 0 ? maxTasks : prioritized.length;
  const limit = Math.min(prioritized.length, cap);
  const rendered: string[] = [];
  for (let i = 0; i < limit; i++) {
    const task = prioritized[i];
    if (task !== undefined) rendered.push(formatTaskLine(task));
  }

  if (prioritized.length > limit) {
    // Per-status overflow counts so failed/killed/live signals survive.
    const hidden: Record<TaskStatus, number> = {
      in_progress: 0,
      pending: 0,
      failed: 0,
      killed: 0,
      completed: 0,
    };
    for (let i = limit; i < prioritized.length; i++) {
      const task = prioritized[i];
      if (task !== undefined) hidden[task.status] += 1;
    }
    const parts: string[] = [];
    for (const status of STATUS_ORDER) {
      if (hidden[status] > 0) parts.push(`${String(hidden[status])} ${status}`);
    }
    const total = prioritized.length - limit;

    // Recovery path: ALWAYS include `task_list` for the full board so hidden
    // live/pending tasks can be re-surfaced. When failures or killed tasks
    // are hidden, ADD status-filtered calls so the followup doesn't re-bury
    // them behind completed history (task_list's default ordering puts
    // completed before failed/killed).
    const recoveryHints: string[] = ["task_list"];
    if (hidden.failed > 0) recoveryHints.push('task_list({status:"failed"})');
    if (hidden.killed > 0) recoveryHints.push('task_list({status:"killed"})');
    const recovery = `call ${recoveryHints.join(" and ")} to reload the full board`;

    rendered.push(
      `… ${String(total)} more task${total === 1 ? "" : "s"} (${parts.join(", ")}) — ${recovery}`,
    );
  }
  return rendered.join("\n");
}

/** Build the full `<system-reminder>` block for a populated board.
 *  `header` is passed through `sanitizeTaskText` so an integrator that sources
 *  it from less-trusted config, env, or manifest metadata cannot inject a
 *  `</system-reminder>` closing tag or newline directives that would reshape
 *  the privileged block. */
export function buildTaskReminder(header: string, body: string): string {
  return [
    "<system-reminder>",
    `${sanitizeTaskText(header)} (internal IDs — do NOT echo them to the user):`,
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

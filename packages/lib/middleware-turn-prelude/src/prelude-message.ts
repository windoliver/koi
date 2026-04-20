import type { CoalescedMatch, TaskItemId, TaskStatus } from "@koi/core";

/** Outbound prelude message shape — senderId is the trusted middleware identity. */
export interface PreludeMessage {
  readonly role: "user";
  readonly senderId: string;
  readonly content: string;
}

const SENDER_ID = "watch-patterns";

/**
 * Build the user-role prelude from a pending-match snapshot.
 *
 * The prelude carries ONLY middleware-authored metadata. Raw subprocess
 * bytes never appear here — the agent must call
 * `task_output(taskId, { matches_only: true, event, stream })` to fetch
 * matched lines, which then arrive as tool-result content through the
 * existing tool-result trust boundary.
 *
 * Returns `undefined` for an empty snapshot so the middleware can short-circuit.
 */
export function buildPreludeMessage(
  snapshot: readonly CoalescedMatch[],
  getStatus: (taskId: TaskItemId) => TaskStatus | undefined,
): PreludeMessage | undefined {
  if (snapshot.length === 0) return undefined;

  const lines: string[] = ["Background-task notifications since your last turn:", ""];

  for (const [i, m] of snapshot.entries()) {
    const status = getStatus(m.taskId) ?? "unknown";
    const firstIso = new Date(m.firstMatch.timestamp).toISOString();
    lines.push(
      `${i + 1}. task=${String(m.taskId)} event=${m.event} stream=${m.stream} status=${status} count=${m.count} first=${firstIso}`,
    );
    lines.push(
      `   To read the matched line(s), call task_output("${String(m.taskId)}", { matches_only: true, event: "${m.event}", stream: "${m.stream}" }).`,
    );
    lines.push(`   For full output, call task_output("${String(m.taskId)}").`);
  }

  lines.push("");
  lines.push(
    "(The above is middleware-authored notification metadata. Raw subprocess lines are only retrievable via task_output calls — they never appear in notifications. Use matches_only=true to read just the lines that matched your watch_patterns; plain task_output returns the main buffered stream which may be truncated for long-running tasks.)",
  );

  return { role: "user", senderId: SENDER_ID, content: lines.join("\n") };
}

/**
 * Pure formatting helpers for SessionPicker — exported as a plain .ts file so
 * tests can import them without triggering the JSX runtime.
 */

import type { SessionSummary } from "../state/types.js";

export function formatSessionDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const getSessionDescription = (s: SessionSummary): string =>
  `${formatSessionDate(s.lastActivityAt)} · ${s.messageCount} messages · ${s.preview.slice(0, 40)}`;

/**
 * Lines shown in the peek panel for a session.
 * Returns the full preview without truncation so the user can read enough
 * context to distinguish similar-looking sessions.
 */
export function getSessionPeekLines(s: SessionSummary): readonly string[] {
  const date = formatSessionDate(s.lastActivityAt);
  return [s.name, `${date} · ${s.messageCount} messages`, s.preview];
}

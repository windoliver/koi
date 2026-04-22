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
 * Max preview characters in the peek panel.
 * Modal is 70 cols; border + padding takes 4 cols, leaving 66 usable characters.
 */
export const PEEK_PREVIEW_MAX = 66;

/**
 * Lines shown in the peek panel for a session.
 * Preview is normalized (newlines → spaces) and capped so it never
 * overflows the fixed-width modal.
 */
export function getSessionPeekLines(s: SessionSummary): readonly string[] {
  const date = formatSessionDate(s.lastActivityAt);
  const preview = s.preview.replace(/\r?\n|\r/g, " ").slice(0, PEEK_PREVIEW_MAX);
  const suffix = s.preview.length > PEEK_PREVIEW_MAX ? "…" : "";
  return [s.name, `${date} · ${s.messageCount} messages`, `${preview}${suffix}`];
}

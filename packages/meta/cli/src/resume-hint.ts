/**
 * Post-quit resume hint for the TUI.
 *
 * Prints the session id and the exact command needed to resume it,
 * mirroring the UX of Claude Code's `claude --resume <id>` message.
 * Callers are expected to skip printing when the session is not
 * resumable (e.g. --until-pass loop mode, which does not persist a
 * JSONL transcript).
 */

import type { SessionId } from "@koi/core";

export function formatResumeHint(id: SessionId): string {
  return `\nResume this session with:\n  koi start --resume ${id}\n`;
}

/**
 * Post-quit resume hint for the TUI.
 *
 * Prints the session id and the exact command needed to resume it,
 * mirroring the UX of Claude Code's `claude --resume <id>` message.
 * Callers are expected to skip printing when the session is not
 * resumable (e.g. --until-pass loop mode, which does not persist a
 * JSONL transcript).
 *
 * The command points at `koi tui --resume` — the TUI itself now
 * accepts `--resume`, so the hint brings the user back into the
 * full-screen UI they just quit out of rather than dropping them
 * into `koi start`'s plain REPL. `koi start --resume <id>` works
 * against the same JSONL files and remains the right option for
 * scripted / non-interactive resume.
 */

import type { SessionId } from "@koi/core";

export function formatResumeHint(id: SessionId): string {
  return `\nResume this session with:\n  koi tui --resume ${id}\n`;
}

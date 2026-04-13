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

/**
 * Shell-safe characters in bash/zsh (plus the common session-id
 * alphabet: hyphen, underscore, colon, period, slash, `%`, digits,
 * letters). Anything outside this set must be quoted before being
 * embedded in a command the user might copy-paste.
 */
const SHELL_SAFE_SESSION_ID = /^[\w.:/%@+=,-]+$/;

/**
 * Wrap a session id in POSIX single quotes, escaping any embedded
 * single quotes via the canonical `'"'"'` dance so the result is a
 * single shell token no matter what characters the id contains.
 * Unsafe characters include `$`, backticks, whitespace, newlines,
 * `;`, `&`, `|`, `<`, `>`, `(`, `)`, `*`, `?`, `[`, `]`, `{`, `}`,
 * `!`, `~`, `#`, backslash, and quotes — any of which could execute
 * extra shell syntax if the user copy-pastes the hint verbatim.
 */
function shellQuoteSessionId(id: string): string {
  if (SHELL_SAFE_SESSION_ID.test(id)) return id;
  return `'${id.replaceAll("'", `'"'"'`)}'`;
}

export function formatResumeHint(id: SessionId): string {
  const quoted = shellQuoteSessionId(String(id));
  return `\nResume this session with:\n  koi tui --resume ${quoted}\n`;
}

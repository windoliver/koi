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

/**
 * Post-quit hint for a picker-mode session. The TUI's runtime is
 * still bound to the startup session id — that is where any new
 * work written during this process lives — while the user may have
 * been viewing a picked archive whose id differs. Print BOTH so
 * the operator can choose:
 *
 *   - the writable startup session (where this process's work
 *     actually landed on disk), and
 *   - the archive they had loaded when they quit (useful for
 *     reopening the same read-only view).
 *
 * Without this, the hint would pick one or the other and strand
 * the other handle — either hiding the archive the user was
 * inspecting, or hiding the writable session that owns their
 * recent work.
 */
export function formatPickerModeResumeHint(
  writableSessionId: SessionId,
  viewedSessionId: SessionId,
): string {
  const writable = shellQuoteSessionId(String(writableSessionId));
  const viewed = shellQuoteSessionId(String(viewedSessionId));
  return (
    "\nResume this session:\n" +
    `  koi tui --resume ${writable}     # writable session (your new work)\n` +
    `  koi tui --resume ${viewed}     # viewed archive (read-only)\n`
  );
}

/**
 * Decide what to do at post-quit time:
 *
 * - `clear-persist-failed`: write stderr warning, skip hint
 * - `cleared-empty`: write stderr note ("session was cleared"), skip hint
 * - `never-persisted`: silently skip — the session never wrote a JSONL
 *   file and advertising the id would point at a nonexistent transcript (#1884)
 * - `normal`: print the single-session hint
 * - `picker`: print the two-line picker hint
 *
 * Extracted from `tui-command.ts` so the branching logic can be unit-tested
 * without spinning up the whole TUI.
 */
export type ResumeHintDecision =
  | { readonly kind: "clear-persist-failed" }
  | { readonly kind: "cleared-empty" }
  | { readonly kind: "never-persisted" }
  | { readonly kind: "normal" }
  | { readonly kind: "picker" };

export interface ResumeHintDecisionInput {
  readonly clearPersistFailed: boolean;
  readonly clearedThisProcess: boolean;
  readonly resumedFromFlag: boolean;
  /** True iff this process rebound `tuiSessionId` to an already-persisted
   *  session via the in-app session picker (`onSessionSelect`). The picked
   *  session's JSONL already exists on disk independent of startup
   *  `--resume` and of any new turns — it must still be resumable even
   *  when the user switches and quits without submitting. #1884. */
  readonly pickedExistingSession: boolean;
  /** Turns counted since the rewind boundary was last armed. Only
   *  advances when `rewindBoundaryActive` is true (i.e. on --resume,
   *  /clear, or /new). A fresh launch's counter stays at 0 even after
   *  many successful turns — use `anyTurnPersistedThisProcess` to
   *  detect "any turn happened". */
  readonly postClearTurnCount: number;
  /** True iff at least one turn completed (settled, uninterrupted)
   *  this process — regardless of the rewind boundary. Signals that
   *  a JSONL transcript was written to disk. #1884. */
  readonly anyTurnPersistedThisProcess: boolean;
  readonly tuiSessionId: SessionId;
  readonly viewedSessionId: SessionId;
}

export function decideResumeHint(input: ResumeHintDecisionInput): ResumeHintDecision {
  if (input.clearPersistFailed) return { kind: "clear-persist-failed" };

  const sessionIsEmpty = input.clearedThisProcess && input.postClearTurnCount === 0;
  if (sessionIsEmpty) return { kind: "cleared-empty" };

  // #1884: suppress the hint when no JSONL transcript was produced.
  // A fresh launch that never committed a turn writes no file, so
  // advertising the session id points at a nonexistent path. Preserve
  // the hint when a backing transcript exists on disk — either opened
  // at startup via --resume, or rebound mid-process via the in-app
  // session picker (both point at real JSONL files).
  const hasBackingTranscript =
    input.resumedFromFlag || input.pickedExistingSession || input.anyTurnPersistedThisProcess;
  const neverPersisted = !input.clearedThisProcess && !hasBackingTranscript;
  if (neverPersisted) return { kind: "never-persisted" };

  if (input.tuiSessionId === input.viewedSessionId) return { kind: "normal" };
  return { kind: "picker" };
}

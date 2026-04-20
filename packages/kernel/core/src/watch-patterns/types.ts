import type { TaskItemId } from "../task-board.js";

/** Key type for `WeakMap`-based per-request match stores (a `WeakKey` alias). */
export type TurnRequestKey = WeakKey;

/** A regex watcher attached to a background process's stdout/stderr. */
export interface WatchPattern {
  readonly pattern: string;
  readonly event: string;
  /** RE2 flag string (default `'i'`). `'g'` and `'y'` are rejected at compile time. */
  readonly flags?: string;
}

/** A single regex-to-line match emitted by the line-buffered matcher. */
export interface PatternMatch {
  readonly taskId: TaskItemId;
  /** Subprocess pid — optional, absent after process exit. */
  readonly pid?: number;
  readonly event: string;
  readonly stream: "stdout" | "stderr";
  readonly lineNumber: number;
  readonly timestamp: number;
}

/** A deduplicated, coalesced view of multiple `PatternMatch` events for the same pattern. */
export interface CoalescedMatch {
  readonly taskId: TaskItemId;
  readonly event: string;
  readonly stream: "stdout" | "stderr";
  readonly firstMatch: PatternMatch;
  readonly count: number;
  readonly lastTimestamp: number;
}

/** Raw match record stored in the ring buffer, including byte-level window metadata. */
export interface MatchEntry {
  readonly event: string;
  readonly stream: "stdout" | "stderr";
  readonly lineNumber: number;
  readonly timestamp: number;
  readonly line: string;
  readonly lineByteLength: number;
  /** Bytes trimmed from the original line when the stored window does not contain the full line. */
  readonly lineClippedPrefixBytes: number;
  /** Bytes trimmed from the original line when the stored window does not contain the full line. */
  readonly lineClippedSuffixBytes: number;
  readonly lineOriginalByteLength: number;
  /** Regex-match span in UTF-16 code-unit offsets into `line`. Always valid within the stored window even after truncation. */
  readonly matchSpanUnits: { readonly start: number; readonly end: number };
}

/** In-memory store that buffers and coalesces `PatternMatch` events until a turn acknowledges them. */
export interface PendingMatchStore {
  readonly record: (match: PatternMatch) => void;
  readonly peek: (request: TurnRequestKey) => readonly CoalescedMatch[];
  readonly ack: (request: TurnRequestKey) => void;
  readonly pending: () => number;
  readonly registerMatcher: (matcher: { readonly cancel: () => void }) => void;
  readonly unregisterMatcher: (matcher: { readonly cancel: () => void }) => void;
  readonly dispose?: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// TaskOutputReader — L0 interface for reading buffered output from a task.
// Structurally satisfied by BashOutputBuffer without an import dependency.
// ---------------------------------------------------------------------------

/** Snapshot of buffered stdout/stderr output for a task. */
export interface TaskOutputReaderSnapshot {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Paginated result of a matched-line query from the side-buffer. */
export interface TaskOutputReaderMatchesResult {
  readonly kind: "matches";
  readonly entries: readonly MatchEntry[];
  readonly cursor: string;
  readonly dropped_before_cursor: number;
  readonly truncated: boolean;
}

/** Filter parameters for a matched-line query. */
export interface TaskOutputReaderMatchQuery {
  readonly event?: string | undefined;
  readonly stream?: "stdout" | "stderr" | undefined;
  readonly offset?: string | undefined;
}

/**
 * Minimal interface for reading buffered output from a running or terminal task.
 * Structurally satisfied by `BashOutputBuffer` from `@koi/tools-bash` without
 * creating an L2→L2 import dependency.
 */
export interface TaskOutputReader {
  readonly snapshot: () => TaskOutputReaderSnapshot;
  readonly queryMatches: (q: TaskOutputReaderMatchQuery) => TaskOutputReaderMatchesResult;
}

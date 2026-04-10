/**
 * Transcript types — append-only message log for session crash recovery.
 *
 * A SessionTranscript captures every turn as a JSONL entry. On restart,
 * messages are replayed from the log. This is the industry-standard pattern
 * used by Claude Code, Codex, and Gemini CLI.
 *
 * Exception: branded type constructor (transcriptEntryId) is permitted
 * in L0 as a zero-logic identity cast for type safety.
 */

import type { SessionId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __transcriptEntryIdBrand: unique symbol;

/** Branded string type for transcript entry identifiers. */
export type TranscriptEntryId = string & {
  readonly [__transcriptEntryIdBrand]: "TranscriptEntryId";
};

/** Create a branded TranscriptEntryId from a plain string. */
export function transcriptEntryId(raw: string): TranscriptEntryId {
  return raw as TranscriptEntryId;
}

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

/** Allowed roles for transcript entries. */
export type TranscriptEntryRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system"
  | "compaction";

/**
 * A single entry within a session transcript.
 * Content is a plain string — callers JSON-serialize structured data before storing.
 */
export interface TranscriptEntry {
  readonly id: TranscriptEntryId;
  readonly role: TranscriptEntryRole;
  readonly content: string;
  /** Unix epoch milliseconds. */
  readonly timestamp: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Options for paginated transcript reads. */
export interface TranscriptPageOptions {
  readonly offset?: number | undefined;
  readonly limit: number;
}

/** A page of transcript entries with cursor metadata. */
export interface TranscriptPage {
  readonly entries: readonly TranscriptEntry[];
  readonly total: number;
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Load result (with corruption diagnostics)
// ---------------------------------------------------------------------------

/** A transcript line that could not be parsed (corruption diagnostic). */
export interface SkippedTranscriptEntry {
  readonly lineNumber: number;
  readonly raw: string;
  readonly error: string;
  /**
   * Whether this is an expected crash artifact (trailing partial write on the last line)
   * or actual mid-file corruption. Use to route to different log severity levels.
   */
  readonly reason: "crash_artifact" | "parse_error";
}

/** Result of loading a full transcript — includes corruption diagnostics. */
export interface TranscriptLoadResult {
  readonly entries: readonly TranscriptEntry[];
  readonly skipped: readonly SkippedTranscriptEntry[];
}

// ---------------------------------------------------------------------------
// Compaction result
// ---------------------------------------------------------------------------

/** Result of a compact() operation — describes what was kept and whether the boundary moved. */
export interface CompactResult {
  /** Actual number of entries preserved (may exceed preserveLastN if boundary was extended). */
  readonly preserved: number;
  /**
   * True if the boundary was extended beyond preserveLastN to avoid splitting a
   * tool_call/tool_result pair. @koi/context-manager should use this to reconcile
   * its own token accounting when the actual preserved count differs from requested.
   */
  readonly extended: boolean;
}

// ---------------------------------------------------------------------------
// Truncation result
// ---------------------------------------------------------------------------

/**
 * Result of a truncate() operation — describes how many entries were retained
 * and how many were dropped.
 *
 * Truncate is the inverse of append: it shrinks the log to the first N
 * entries and discards the rest. Used by @koi/checkpoint to roll back the
 * conversation log to match a snapshot's file-state when /rewind fires.
 *
 * Unlike compact(), truncate does NOT add a synthesis entry — it produces
 * a strict prefix of the existing log. The caller is responsible for
 * ensuring the truncation point falls on a turn boundary (otherwise replay
 * may surface tool_call/tool_result pairs split across the cut).
 */
export interface TruncateResult {
  /** Number of entries kept (= the requested keepFirstN, capped at the original length). */
  readonly kept: number;
  /** Number of entries dropped from the end of the log. */
  readonly dropped: number;
}

// ---------------------------------------------------------------------------
// Main interface
// ---------------------------------------------------------------------------

/**
 * Append-only transcript store for session crash recovery.
 *
 * - `append` writes entries to the log
 * - `load` reads all entries (with corruption diagnostics)
 * - `loadPage` reads a page of entries
 * - `compact` replaces old entries with a summary + preserved tail
 * - `truncate` shrinks the log to a strict prefix of `keepFirstN` entries
 *    (used by @koi/checkpoint to roll back the conversation half of a rewind)
 * - `remove` deletes the transcript
 * - `close` releases resources
 */
export interface SessionTranscript {
  readonly append: (
    sessionId: SessionId,
    entries: readonly TranscriptEntry[],
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly load: (
    sessionId: SessionId,
  ) => Result<TranscriptLoadResult, KoiError> | Promise<Result<TranscriptLoadResult, KoiError>>;

  readonly loadPage: (
    sessionId: SessionId,
    options: TranscriptPageOptions,
  ) => Result<TranscriptPage, KoiError> | Promise<Result<TranscriptPage, KoiError>>;

  readonly compact: (
    sessionId: SessionId,
    summary: string,
    preserveLastN: number,
  ) => Result<CompactResult, KoiError> | Promise<Result<CompactResult, KoiError>>;

  /**
   * Shrink the transcript to its first `keepFirstN` entries. Drops everything
   * after that index. Idempotent: calling truncate(N) twice produces the same
   * result.
   *
   * Returns `{ kept, dropped }`. If `keepFirstN` exceeds the existing length,
   * `kept` equals the existing length and `dropped` is 0.
   *
   * The caller is responsible for ensuring the cut point lands on a turn
   * boundary — truncating in the middle of a tool_call/tool_result pair will
   * leave the log unable to replay cleanly. @koi/checkpoint records the
   * post-turn entry count in each snapshot's payload so it can pass the
   * right value here.
   */
  readonly truncate: (
    sessionId: SessionId,
    keepFirstN: number,
  ) => Result<TruncateResult, KoiError> | Promise<Result<TruncateResult, KoiError>>;

  readonly remove: (
    sessionId: SessionId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly close: () => void | Promise<void>;
}

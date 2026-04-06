/**
 * Session persistence contract — L0 types for crash recovery.
 *
 * Promoted from @koi/session-store so that both @koi/session-store (L2)
 * and @koi/node (L2) can depend on the same contract without L2→L2 imports.
 *
 * Implementation-specific config (dbPath, durability) stays in L2.
 */

import type { AgentManifest } from "./assembly.js";
import type { AgentId, ProcessState, SessionId } from "./ecs.js";
import type { EngineState } from "./engine.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Session record — lightweight session metadata for reconnection
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a persisted session.
 *
 * - "idle"    — default; session exists but no engine turn is active.
 * - "running" — engine turn is in progress. A session in this state after restart
 *               indicates a crash (SIGTERM handled cleanly; SIGKILL/OOM leaves
 *               status="running" — recover() returns these as crash candidates).
 * - "done"    — session has been explicitly closed and will not be resumed.
 */
export type SessionStatus = "running" | "idle" | "done";

export interface SessionRecord {
  /** Gateway session ID. */
  readonly sessionId: SessionId;
  /** Agent this session belongs to. */
  readonly agentId: AgentId;
  /** Agent manifest snapshot for re-assembly on recovery. */
  readonly manifestSnapshot: AgentManifest;
  /** Outbound sequence counter. */
  readonly seq: number;
  /** Last accepted inbound sequence from remote. */
  readonly remoteSeq: number;
  /** Unix timestamp ms when session was created. */
  readonly connectedAt: number;
  /** Unix timestamp ms of the most recent persistence event. */
  readonly lastPersistedAt: number;
  /** Opaque engine state for fast stateful recovery. */
  readonly lastEngineState?: EngineState | undefined;
  /**
   * Current lifecycle status. Defaults to "idle".
   * Used by recover() callers to identify crash candidates (status="running").
   */
  readonly status: SessionStatus;
  /** Arbitrary metadata. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Pending frame — outbound frame buffered during disconnection
// ---------------------------------------------------------------------------

export interface PendingFrame {
  /** Unique frame identifier. */
  readonly frameId: string;
  /** Session this frame belongs to. */
  readonly sessionId: SessionId;
  /** Agent that originated this frame. */
  readonly agentId: AgentId;
  /** Frame type discriminator (e.g., "agent:message"). */
  readonly frameType: string;
  /** Serialized frame payload. */
  readonly payload: unknown;
  /** Ordering index within the session's pending queue. */
  readonly orderIndex: number;
  /** Unix timestamp ms when this frame was buffered. */
  readonly createdAt: number;
  /** Optional time-to-live in ms. Undefined = no expiry. */
  readonly ttl?: number | undefined;
  /** Number of delivery attempts. 0 = never attempted. */
  readonly retryCount: number;
}

// ---------------------------------------------------------------------------
// Skipped recovery entry — records rows that couldn't be deserialized
// ---------------------------------------------------------------------------

export interface SkippedRecoveryEntry {
  /** Which table the corrupt row came from. */
  readonly source: "session" | "pending_frame";
  /** Row identifier (sessionId or frameId). */
  readonly id: string;
  /** Human-readable error description. */
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Recovery plan — what recover() returns
// ---------------------------------------------------------------------------

export interface RecoveryPlan {
  /** All session records found in the store. */
  readonly sessions: readonly SessionRecord[];
  /** Pending outbound frames per session (keyed by sessionId). */
  readonly pendingFrames: ReadonlyMap<string, readonly PendingFrame[]>;
  /** Rows that could not be deserialized (corrupt JSON, invalid state, etc.). */
  readonly skipped: readonly SkippedRecoveryEntry[];
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export interface SessionFilter {
  readonly agentId?: AgentId;
  readonly processState?: ProcessState;
}

// ---------------------------------------------------------------------------
// Content replacement record — tracks messages replaced with file-backed refs
// ---------------------------------------------------------------------------

/**
 * Metadata for a message whose content was replaced with a file-backed reference
 * by @koi/context-manager during a compaction pass.
 *
 * On session resume, loadContentReplacements() returns these records so the
 * context-manager can restore file-backed content into the message array before
 * the first model call.
 */
export interface ContentReplacement {
  /** Session the replacement belongs to. */
  readonly sessionId: SessionId;
  /** ID of the InboundMessage whose content was replaced. */
  readonly messageId: string;
  /** Absolute path to the file holding the replaced content. */
  readonly filePath: string;
  /** Size in bytes of the original content (for token accounting). */
  readonly byteCount: number;
  /** Unix timestamp ms when the replacement was made. */
  readonly replacedAt: number;
}

// ---------------------------------------------------------------------------
// Session persistence interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for durable session storage.
 *
 * All methods return `T | Promise<T>` — in-memory implementations are sync,
 * SQLite/network implementations are async. Callers must always `await`.
 *
 * All fallible operations return `Result<T, KoiError>`.
 */
export interface SessionPersistence {
  // -- Session records -----------------------------------------------------

  /** Save or update a session record. */
  readonly saveSession: (
    record: SessionRecord,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Load a session record by session ID. NOT_FOUND if missing. */
  readonly loadSession: (
    sessionId: string,
  ) => Result<SessionRecord, KoiError> | Promise<Result<SessionRecord, KoiError>>;

  /** Remove a session record and its associated data. NOT_FOUND if missing. */
  readonly removeSession: (
    sessionId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** List session records matching an optional filter. */
  readonly listSessions: (
    filter?: SessionFilter,
  ) =>
    | Result<readonly SessionRecord[], KoiError>
    | Promise<Result<readonly SessionRecord[], KoiError>>;

  // -- Pending frames ------------------------------------------------------

  /** Save a pending outbound frame for replay after reconnection. */
  readonly savePendingFrame: (
    frame: PendingFrame,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Load all pending frames for a session, ordered by orderIndex. */
  readonly loadPendingFrames: (
    sessionId: string,
  ) =>
    | Result<readonly PendingFrame[], KoiError>
    | Promise<Result<readonly PendingFrame[], KoiError>>;

  /** Clear all pending frames for a session (after successful drain). */
  readonly clearPendingFrames: (
    sessionId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Remove a single pending frame by ID. No-op if not found. */
  readonly removePendingFrame: (
    frameId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  // -- Session status ------------------------------------------------------

  /**
   * Update the lifecycle status of a session.
   *
   * Call with "running" at the start of an engine turn and "idle" on clean completion.
   * Call with "done" when the session is permanently closed.
   *
   * Note: SIGKILL/OOM crashes leave status="running". On restart, recover() callers
   * should treat sessions with status="running" as crash candidates and attempt
   * transcript-based resume.
   */
  readonly setSessionStatus: (
    sessionId: string,
    status: SessionStatus,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  // -- Content replacements ------------------------------------------------

  /**
   * Record that a message's content was replaced with a file-backed reference.
   * Called by @koi/context-manager after writing replaced content to disk.
   */
  readonly saveContentReplacement: (
    record: ContentReplacement,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Load all content replacements for a session.
   * Called at resume time to restore file-backed content before the first model call.
   * Returns an empty array for sessions with no replacements.
   */
  readonly loadContentReplacements: (
    sessionId: string,
  ) =>
    | Result<readonly ContentReplacement[], KoiError>
    | Promise<Result<readonly ContentReplacement[], KoiError>>;

  // -- Recovery ------------------------------------------------------------

  /**
   * Build a full recovery plan from all stored data.
   * Returns all session records and pending frames per session.
   * Corrupt rows are skipped and reported in the `skipped` field.
   *
   * Callers identify crash candidates by filtering sessions where status="running".
   * Synchronous for SQLite — runs once at CLI startup before the event loop is live.
   * See Phase 3 daemon work for async migration if throughput becomes a concern.
   */
  readonly recover: () => Result<RecoveryPlan, KoiError> | Promise<Result<RecoveryPlan, KoiError>>;

  // -- Lifecycle -----------------------------------------------------------

  /** Close the store and release resources. */
  readonly close: () => void | Promise<void>;
}

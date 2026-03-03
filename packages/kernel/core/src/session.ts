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

  // -- Recovery ------------------------------------------------------------

  /**
   * Build a full recovery plan from all stored data.
   * Returns all session records and pending frames per session.
   * Corrupt rows are skipped and reported in the `skipped` field.
   */
  readonly recover: () => Result<RecoveryPlan, KoiError> | Promise<Result<RecoveryPlan, KoiError>>;

  // -- Lifecycle -----------------------------------------------------------

  /** Close the store and release resources. */
  readonly close: () => void | Promise<void>;
}

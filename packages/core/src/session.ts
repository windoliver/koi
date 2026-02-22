/**
 * Session persistence contract — L0 types for crash recovery.
 *
 * Promoted from @koi/session-store so that both @koi/session-store (L2)
 * and @koi/node (L2) can depend on the same contract without L2→L2 imports.
 *
 * Implementation-specific config (dbPath, durability) stays in L2.
 */

import type { AgentManifest } from "./assembly.js";
import type { AgentId, ProcessState } from "./ecs.js";
import type { EngineState } from "./engine.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Checkpoint — engine state snapshot at a point in time
// ---------------------------------------------------------------------------

export interface SessionCheckpoint {
  /** Unique checkpoint ID (e.g., `${agentId}:${Date.now()}`). */
  readonly id: string;
  /** Agent this checkpoint belongs to. */
  readonly agentId: AgentId;
  /** Gateway session this agent was part of. */
  readonly sessionId: string;
  /** Opaque engine state from EngineAdapter.saveState(). */
  readonly engineState: EngineState;
  /** Lifecycle phase at checkpoint time. */
  readonly processState: ProcessState;
  /** CAS generation counter from AgentStatus. */
  readonly generation: number;
  /** Arbitrary metadata (e.g., trigger reason). */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Unix timestamp ms when this checkpoint was created. */
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Session record — lightweight session metadata for reconnection
// ---------------------------------------------------------------------------

export interface SessionRecord {
  /** Gateway session ID. */
  readonly sessionId: string;
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
  /** Unix timestamp ms of the most recent checkpoint. */
  readonly lastCheckpointAt: number;
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
  readonly sessionId: string;
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
  readonly source: "session" | "checkpoint" | "pending_frame";
  /** Row identifier (sessionId, checkpoint id, or frameId). */
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
  /** Latest checkpoint per agent (keyed by agentId string). */
  readonly checkpoints: ReadonlyMap<string, SessionCheckpoint>;
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

  /** Remove a session record and its checkpoints. NOT_FOUND if missing. */
  readonly removeSession: (
    sessionId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** List session records matching an optional filter. */
  readonly listSessions: (
    filter?: SessionFilter,
  ) =>
    | Result<readonly SessionRecord[], KoiError>
    | Promise<Result<readonly SessionRecord[], KoiError>>;

  // -- Checkpoints ---------------------------------------------------------

  /** Save a checkpoint. Prunes oldest if over retention limit. */
  readonly saveCheckpoint: (
    checkpoint: SessionCheckpoint,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Load the most recent checkpoint for an agent. Returns undefined if none. */
  readonly loadLatestCheckpoint: (
    agentId: AgentId,
  ) =>
    | Result<SessionCheckpoint | undefined, KoiError>
    | Promise<Result<SessionCheckpoint | undefined, KoiError>>;

  /** List all checkpoints for an agent, newest first. */
  readonly listCheckpoints: (
    agentId: AgentId,
  ) =>
    | Result<readonly SessionCheckpoint[], KoiError>
    | Promise<Result<readonly SessionCheckpoint[], KoiError>>;

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
   * Returns all session records, the latest checkpoint per agent,
   * and pending frames per session. Corrupt rows are skipped and
   * reported in the `skipped` field.
   */
  readonly recover: () => Result<RecoveryPlan, KoiError> | Promise<Result<RecoveryPlan, KoiError>>;

  // -- Lifecycle -----------------------------------------------------------

  /** Close the store and release resources. */
  readonly close: () => void | Promise<void>;
}

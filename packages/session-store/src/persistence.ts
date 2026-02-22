/**
 * SessionPersistence — pluggable interface for durable session storage.
 *
 * All methods return `T | Promise<T>` — in-memory implementations are sync,
 * SQLite/network implementations are async. Callers must always `await`.
 *
 * All fallible operations return `Result<T, KoiError>`.
 */

import type { AgentId, KoiError, Result } from "@koi/core";
import type {
  PendingFrame,
  RecoveryPlan,
  SessionCheckpoint,
  SessionFilter,
  SessionRecord,
} from "./types.js";

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
   * and pending frames per session.
   */
  readonly recover: () => Result<RecoveryPlan, KoiError> | Promise<Result<RecoveryPlan, KoiError>>;

  // -- Lifecycle -----------------------------------------------------------

  /** Close the store and release resources. */
  readonly close: () => void | Promise<void>;
}

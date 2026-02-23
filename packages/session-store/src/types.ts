/**
 * Session persistence types for crash recovery on edge devices.
 *
 * SessionCheckpoint captures engine state at a point in time.
 * SessionRecord captures lightweight session metadata for reconnection.
 * RecoveryPlan is returned by recover() to enumerate what can be restored.
 */

import type { AgentId, AgentManifest, EngineState, ProcessState } from "@koi/core";

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
// Recovery plan — what recover() returns
// ---------------------------------------------------------------------------

export interface RecoveryPlan {
  /** All session records found in the store. */
  readonly sessions: readonly SessionRecord[];
  /** Latest checkpoint per agent (keyed by agentId string). */
  readonly checkpoints: ReadonlyMap<string, SessionCheckpoint>;
  /** Pending outbound frames per session (keyed by sessionId). */
  readonly pendingFrames: ReadonlyMap<string, readonly PendingFrame[]>;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export interface SessionFilter {
  readonly agentId?: AgentId;
  readonly processState?: ProcessState;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionStoreConfig {
  /** Database file path, or ":memory:" for in-memory. */
  readonly dbPath: string;
  /**
   * Durability level:
   * - "process": durable against process crashes (SQLite WAL + synchronous=NORMAL)
   * - "os": durable against OS/power crashes (SQLite WAL + synchronous=FULL)
   * Default: "process"
   */
  readonly durability?: "process" | "os";
  /** Maximum checkpoints retained per agent. Oldest pruned on save. Default: 3. */
  readonly maxCheckpointsPerAgent?: number;
}

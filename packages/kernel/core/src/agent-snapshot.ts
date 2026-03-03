/**
 * AgentSnapshot — per-agent state capture for time travel, fork, and recovery.
 *
 * Single source of truth for agent state snapshots.
 * Used as the payload type `T` in `SnapshotChainStore<AgentSnapshot>`.
 */

import type { BrickRef } from "./brick-snapshot.js";
import type { AgentId, ProcessState } from "./ecs.js";
import type { EngineState } from "./engine.js";
import type { SnapshotChainStore } from "./snapshot-chain.js";

// ---------------------------------------------------------------------------
// AgentSnapshot payload
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of an agent's complete state at a point in time.
 *
 * Contains everything needed to restore an agent: engine state, process phase,
 * generation counter, attached components (as BrickRefs), and config.
 */
export interface AgentSnapshot {
  /** The agent this snapshot belongs to. */
  readonly agentId: AgentId;
  /** Gateway session this agent was part of. */
  readonly sessionId: string;
  /** Opaque engine state from EngineAdapter.saveState(). */
  readonly engineState: EngineState;
  /** Lifecycle phase at snapshot time. */
  readonly processState: ProcessState;
  /** CAS generation counter from AgentStatus. */
  readonly generation: number;
  /** Attached components as lightweight brick references. */
  readonly components: ReadonlyMap<string, BrickRef>;
  /** Agent configuration snapshot (opaque, agent-defined). */
  readonly config: unknown;
  /** Arbitrary metadata (e.g., trigger reason). */
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Type alias for convenience
// ---------------------------------------------------------------------------

/** A SnapshotChainStore specialized for AgentSnapshot payloads. */
export type AgentSnapshotStore = SnapshotChainStore<AgentSnapshot>;

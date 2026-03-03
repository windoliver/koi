/**
 * Eviction policy contract — candidate selection for agent eviction.
 *
 * The EvictionPolicy interface defines a pluggable strategy for selecting
 * which agents to evict when resources are constrained. Implementations
 * (LRU, QoS-aware) are L2 packages.
 */

import type { AgentId, ProcessState } from "./ecs.js";

// ---------------------------------------------------------------------------
// Eviction candidate
// ---------------------------------------------------------------------------

/** An agent eligible for eviction, with metadata for policy decisions. */
export interface EvictionCandidate {
  readonly agentId: AgentId;
  readonly phase: ProcessState;
  /** Unix timestamp ms of the last heartbeat. */
  readonly lastHeartbeat: number;
  /** Eviction priority — lower values are evicted first. */
  readonly priority: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Eviction reason
// ---------------------------------------------------------------------------

/** Why eviction was triggered. */
export type EvictionReason = "idle_timeout" | "memory_pressure" | "preemption" | "manual";

// ---------------------------------------------------------------------------
// Eviction result
// ---------------------------------------------------------------------------

/** Outcome of an eviction cycle. */
export interface EvictionResult {
  readonly evicted: readonly AgentId[];
  readonly skipped: number;
  readonly reason: EvictionReason;
}

// ---------------------------------------------------------------------------
// Eviction policy (pluggable strategy)
// ---------------------------------------------------------------------------

/**
 * Strategy for selecting which agents to evict. Implementations receive
 * a pre-filtered candidate list and return the selected subset.
 *
 * Built-in implementations (L2):
 * - LRU: oldest heartbeat first
 * - QoS-aware: lowest priority first, then oldest heartbeat
 */
export interface EvictionPolicy {
  readonly name: string;
  /** Select up to `count` candidates for eviction from the provided list. */
  readonly selectCandidates: (
    candidates: readonly EvictionCandidate[],
    count: number,
  ) => readonly EvictionCandidate[];
}

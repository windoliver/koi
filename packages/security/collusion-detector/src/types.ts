/**
 * Types for cross-agent collusion detection.
 *
 * Uses the Institutional AI pattern: 4 deterministic signal detectors
 * monitor agent populations for coordinated behavior anomalies.
 */

import type { AgentId } from "@koi/core/ecs";
import type { ViolationSeverity } from "@koi/core/governance-backend";

// ---------------------------------------------------------------------------
// AgentObservation — one round of metrics for one agent
// ---------------------------------------------------------------------------

/** A single observation of an agent's behavior in one round. */
export interface AgentObservation {
  /** The observed agent. */
  readonly agentId: AgentId;
  /** Round number (monotonically increasing). */
  readonly round: number;
  /** Unix timestamp (ms) when the observation was recorded. */
  readonly timestamp: number;
  /** Tool usage distribution: toolId → call count. */
  readonly toolCallCounts: ReadonlyMap<string, number>;
  /** Resource access distribution: resourceId → access count. */
  readonly resourceAccessCounts: ReadonlyMap<string, number>;
  /** Delta in trust scores given to peers: agentId → score change. */
  readonly trustScoreChanges: ReadonlyMap<string, number>;
}

// ---------------------------------------------------------------------------
// CollusionSignal — detected collusion indicator
// ---------------------------------------------------------------------------

/** Kind of collusion signal detected. */
export type CollusionSignalKind =
  | "sync_move"
  | "variance_collapse"
  | "concentration"
  | "specialization";

/** A detected collusion signal with evidence and severity. */
export interface CollusionSignal {
  /** The type of collusion pattern detected. */
  readonly kind: CollusionSignalKind;
  /** How severe this signal is. */
  readonly severity: ViolationSeverity;
  /** Evidence map: agentId → metric value. */
  readonly evidence: ReadonlyMap<string, number>;
  /** The round in which the signal was detected. */
  readonly round: number;
  /** Unix timestamp (ms) of detection. */
  readonly timestamp: number;
  /** Human-readable description. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// CollusionThresholds — configurable per-signal thresholds
// ---------------------------------------------------------------------------

/** Configurable thresholds for each collusion detection signal. */
export interface CollusionThresholds {
  /** Minimum agents to detect synchronous move. Default: 3. */
  readonly syncMoveMinAgents: number;
  /** Percentage change threshold for sync move detection. Default: 0.2 (20%). */
  readonly syncMoveChangePct: number;
  /** Maximum coefficient of variation for variance collapse. Default: 0.1. */
  readonly varianceCollapseMaxCv: number;
  /** Minimum consecutive rounds below CV threshold. Default: 5. */
  readonly varianceCollapseMinRounds: number;
  /** Herfindahl-Hirschman Index threshold for concentration. Default: 0.25. */
  readonly concentrationHhiThreshold: number;
  /** Minimum CV indicating high specialization (market division). Default: 2.0. */
  readonly specializationCvMin: number;
}

// ---------------------------------------------------------------------------
// CollusionDetectorConfig
// ---------------------------------------------------------------------------

/** Configuration for the collusion detector. */
export interface CollusionDetectorConfig {
  /** Per-signal threshold overrides. */
  readonly thresholds?: Partial<CollusionThresholds> | undefined;
  /** Sliding window size in rounds. Default: 50. */
  readonly windowSize?: number | undefined;
}

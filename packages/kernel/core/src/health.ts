/**
 * Health monitoring contract — heartbeat recording, staleness detection.
 *
 * Implementations use a two-tier architecture: in-memory buffer for hot
 * writes, periodic flush to the registry for staleness sweeps.
 */

import type { AgentId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

/** Agent health determined by heartbeat recency. */
export type HealthStatus = "alive" | "suspect" | "dead";

// ---------------------------------------------------------------------------
// Health snapshot
// ---------------------------------------------------------------------------

/** Point-in-time health assessment for a single agent. */
export interface HealthSnapshot {
  readonly agentId: AgentId;
  readonly status: HealthStatus;
  /** Unix timestamp ms of the last recorded heartbeat. 0 if never received. */
  readonly lastHeartbeat: number;
  /** Number of consecutive missed health checks. */
  readonly missedChecks: number;
}

// ---------------------------------------------------------------------------
// Health monitor stats
// ---------------------------------------------------------------------------

/** Operational statistics for the health monitoring system. */
export interface HealthMonitorStats {
  /** Total heartbeats recorded since startup. */
  readonly totalRecorded: number;
  /** Total heartbeats flushed to the registry. */
  readonly totalFlushed: number;
  /** Current number of entries in the in-memory buffer. */
  readonly bufferSize: number;
  /** Number of flush cycles completed. */
  readonly flushCount: number;
}

// ---------------------------------------------------------------------------
// Health monitor configuration
// ---------------------------------------------------------------------------

/** Configuration for the health monitoring system. */
export interface HealthMonitorConfig {
  /** How often to flush the heartbeat buffer to the registry (ms). Default: 30_000. */
  readonly flushIntervalMs: number;
  /** How often to sweep for stale agents (ms). Default: 10_000. */
  readonly sweepIntervalMs: number;
  /** Time without heartbeat before an agent is considered suspect (ms). Default: 60_000. */
  readonly suspectThresholdMs: number;
  /** Time without heartbeat before an agent is considered dead (ms). Default: 120_000. */
  readonly deadThresholdMs: number;
}

/** Default health monitor configuration. */
export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = Object.freeze({
  flushIntervalMs: 30_000,
  sweepIntervalMs: 10_000,
  suspectThresholdMs: 60_000,
  deadThresholdMs: 120_000,
});

// ---------------------------------------------------------------------------
// Health monitor contract
// ---------------------------------------------------------------------------

/**
 * Pluggable health monitoring interface. Tracks agent heartbeats
 * and detects staleness.
 *
 * `record()` is synchronous (hot path — writes to in-memory buffer).
 * `check()` returns `T | Promise<T>` for async-ready implementations.
 */
export interface HealthMonitor extends AsyncDisposable {
  /** Record a heartbeat for an agent. Hot path — always synchronous. */
  readonly record: (agentId: AgentId) => void;

  /** Check the current health of an agent. May involve I/O. */
  readonly check: (agentId: AgentId) => HealthSnapshot | Promise<HealthSnapshot>;

  /** Return current buffer and flush statistics. */
  readonly stats: () => HealthMonitorStats;
}

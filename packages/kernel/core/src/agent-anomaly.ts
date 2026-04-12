/**
 * Agent anomaly types — statistical and behavioral anomaly signals.
 *
 * AnomalySignal is a discriminated union of behavioral patterns detected
 * by the agent monitor. These feed into the composition planner via
 * SystemSignal to trigger autonomous intervention.
 *
 * L0 types only — zero logic, zero deps beyond @koi/core internal files.
 *
 * Runtime detection lives in @koi/agent-monitor (L2).
 * Ported from v1 @koi/agent-monitor/src/types.ts.
 */

import type { AgentId, SessionId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Base fields — common to every anomaly signal
// ---------------------------------------------------------------------------

export interface AnomalyBase {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  /** Unix timestamp (ms) when the anomaly was detected. */
  readonly timestamp: number;
  /** Zero-indexed turn number within the session when the anomaly was detected. */
  readonly turnIndex: number;
}

// ---------------------------------------------------------------------------
// AnomalyDetail — discriminated union of behavioral patterns
// ---------------------------------------------------------------------------

export type AnomalyDetail =
  /** Tool call rate exceeded the configured threshold for this turn. */
  | {
      readonly kind: "tool_rate_exceeded";
      readonly callsPerTurn: number;
      readonly threshold: number;
    }
  /** Error call count exceeded the threshold (repeated tool failures). */
  | {
      readonly kind: "error_spike";
      readonly errorCount: number;
      readonly threshold: number;
    }
  /** Same tool called repeatedly (stuck-in-loop detection). */
  | {
      readonly kind: "tool_repeated";
      readonly toolId: string;
      readonly repeatCount: number;
      readonly threshold: number;
    }
  /** Model response latency is a statistical outlier (mean + N×stddev). */
  | {
      readonly kind: "model_latency_anomaly";
      readonly latencyMs: number;
      readonly mean: number;
      readonly stddev: number;
      /** How many standard deviations above the mean. */
      readonly factor: number;
    }
  /** Too many permission-denied tool calls this turn. */
  | {
      readonly kind: "denied_tool_calls";
      readonly deniedCount: number;
      readonly threshold: number;
    }
  /** Destructive/irreversible tool called too many times in a single turn. */
  | {
      readonly kind: "irreversible_action_rate";
      readonly toolId: string;
      readonly callsThisTurn: number;
      readonly threshold: number;
    }
  /** Model output token count is a statistical outlier. */
  | {
      readonly kind: "token_spike";
      readonly outputTokens: number;
      readonly mean: number;
      readonly stddev: number;
      /** How many standard deviations above the mean. */
      readonly factor: number;
    }
  /** Too many distinct tools called in a single turn (sweep behavior). */
  | {
      readonly kind: "tool_diversity_spike";
      readonly distinctToolCount: number;
      readonly threshold: number;
    }
  /** Agent alternates between exactly two tools (A→B→A→B… ping-pong). */
  | {
      readonly kind: "tool_ping_pong";
      readonly toolIdA: string;
      readonly toolIdB: string;
      /** Number of alternations detected. */
      readonly altCount: number;
      readonly threshold: number;
    }
  /** Session has been running longer than the configured limit. */
  | {
      readonly kind: "session_duration_exceeded";
      readonly durationMs: number;
      readonly threshold: number;
    }
  /** Agent attempted to spawn a sub-agent when the delegation chain is already at max depth. */
  | {
      readonly kind: "delegation_depth_exceeded";
      readonly currentDepth: number;
      readonly maxDepth: number;
      readonly spawnToolId: string;
    }
  /** None of the agent's tool calls this turn matched any declared manifest objective. */
  | {
      readonly kind: "goal_drift";
      /** Drift score: 0.0 (fully aligned) – 1.0 (fully drifted). */
      readonly driftScore: number;
      readonly threshold: number;
      readonly objectives: readonly string[];
    };

// ---------------------------------------------------------------------------
// AnomalySignal — base context + specific anomaly detail
// ---------------------------------------------------------------------------

/** Full anomaly signal: behavioral detection context + anomaly-specific fields. */
export type AnomalySignal = AnomalyBase & AnomalyDetail;

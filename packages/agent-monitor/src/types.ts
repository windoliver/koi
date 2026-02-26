/**
 * Public types for @koi/agent-monitor.
 *
 * AnomalySignal is a discriminated union: AnomalyBase & AnomalyDetail.
 * Per-kind fields only appear on the relevant variant.
 */

import type { SessionId } from "@koi/core/ecs";

// ---------------------------------------------------------------------------
// Anomaly signal
// ---------------------------------------------------------------------------

type AnomalyBase = {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly timestamp: number;
  readonly turnIndex: number;
};

type AnomalyDetail =
  | {
      readonly kind: "tool_rate_exceeded";
      readonly callsPerTurn: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "error_spike";
      readonly errorCount: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "tool_repeated";
      readonly toolId: string;
      readonly repeatCount: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "model_latency_anomaly";
      readonly latencyMs: number;
      readonly mean: number;
      readonly stddev: number;
      readonly factor: number;
    }
  | {
      readonly kind: "denied_tool_calls";
      readonly deniedCount: number;
      readonly threshold: number;
    }
  | {
      /** Gap 1: destructive/irreversible tool called too many times this turn. */
      readonly kind: "irreversible_action_rate";
      readonly toolId: string;
      readonly callsThisTurn: number;
      readonly threshold: number;
    }
  | {
      /** Gap 2: model output token count is a statistical outlier. */
      readonly kind: "token_spike";
      readonly outputTokens: number;
      readonly mean: number;
      readonly stddev: number;
      readonly factor: number;
    }
  | {
      /** Gap 3: too many distinct tools called in a single turn (sweep behaviour). */
      readonly kind: "tool_diversity_spike";
      readonly distinctToolCount: number;
      readonly threshold: number;
    }
  | {
      /** Gap A: agent ping-pongs between exactly two tools (A→B→A→B…). */
      readonly kind: "tool_ping_pong";
      readonly toolIdA: string;
      readonly toolIdB: string;
      readonly altCount: number;
      readonly threshold: number;
    }
  | {
      /** Gap B: session has been running longer than the configured limit. */
      readonly kind: "session_duration_exceeded";
      readonly durationMs: number;
      readonly threshold: number;
    }
  | {
      /**
       * Phase 2: agent at currentDepth called a spawn tool when
       * currentDepth >= maxDelegationDepth — delegation chain too deep.
       */
      readonly kind: "delegation_depth_exceeded";
      readonly currentDepth: number;
      readonly maxDepth: number;
      readonly spawnToolId: string;
    };

export type AnomalySignal = AnomalyBase & AnomalyDetail;

// ---------------------------------------------------------------------------
// Session metrics summary (emitted once at session end)
// ---------------------------------------------------------------------------

export interface SessionMetricsSummary {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly totalToolCalls: number;
  readonly totalModelCalls: number;
  readonly totalErrorCalls: number;
  readonly totalDeniedCalls: number;
  readonly totalDestructiveCalls: number;
  readonly anomalyCount: number;
  readonly turnCount: number;
  readonly meanLatencyMs: number;
  readonly latencyStddevMs: number;
  readonly meanOutputTokens: number;
  readonly outputTokenStddev: number;
}

// ---------------------------------------------------------------------------
// Latency stats (used by detector)
// ---------------------------------------------------------------------------

export interface LatencyStats {
  readonly count: number;
  readonly mean: number;
  readonly stddev: number;
}

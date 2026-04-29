import type { AgentId, SessionId } from "@koi/core";

export interface LatencyStats {
  readonly mean: number;
  readonly stddev: number;
  readonly count: number;
  readonly m2: number;
}

export interface SessionMetricsSummary {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
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

/** Internal — not exported from package barrel. Mutable per-session state. */
export interface SessionMetrics {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly startedAt: number;
  turnIndex: number;
  totalToolCalls: number;
  totalModelCalls: number;
  totalErrorCalls: number;
  totalDeniedCalls: number;
  totalDestructiveCalls: number;
  anomalyCount: number;
  toolCallsThisTurn: number;
  distinctToolsThisTurn: Set<string>;
  destructiveThisTurn: Map<string, number>;
  goalDriftMatchedThisTurn: boolean;
  toolIdsThisTurn: string[];
  lastToolId: string | null;
  consecutiveRepeat: number;
  prevToolId: string | null;
  pingPongAltCount: number;
  latency: LatencyStats;
  outputTokens: LatencyStats;
}

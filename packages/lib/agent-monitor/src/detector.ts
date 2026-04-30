import type { AnomalyDetail } from "@koi/core";
import type { AgentMonitorThresholds } from "./config.js";
import type { LatencyStats, SessionMetrics } from "./types.js";

export function detectToolRateExceeded(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  return m.toolCallsThisTurn > t.maxToolCallsPerTurn
    ? {
        kind: "tool_rate_exceeded",
        callsPerTurn: m.toolCallsThisTurn,
        threshold: t.maxToolCallsPerTurn,
      }
    : null;
}

export function detectErrorSpike(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  return m.totalErrorCalls > t.maxErrorCallsPerSession
    ? {
        kind: "error_spike",
        errorCount: m.totalErrorCalls,
        threshold: t.maxErrorCallsPerSession,
      }
    : null;
}

export function detectToolRepeated(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  if (m.lastToolId === null) return null;
  return m.consecutiveRepeat > t.maxConsecutiveRepeatCalls
    ? {
        kind: "tool_repeated",
        toolId: m.lastToolId,
        repeatCount: m.consecutiveRepeat,
        threshold: t.maxConsecutiveRepeatCalls,
      }
    : null;
}

export function detectDeniedToolCalls(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  return m.totalDeniedCalls > t.maxDeniedCallsPerSession
    ? {
        kind: "denied_tool_calls",
        deniedCount: m.totalDeniedCalls,
        threshold: t.maxDeniedCallsPerSession,
      }
    : null;
}

export function detectIrreversibleActionRate(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
  toolId: string,
): AnomalyDetail | null {
  const count = m.destructiveThisTurn.get(toolId) ?? 0;
  return count > t.maxDestructiveCallsPerTurn
    ? {
        kind: "irreversible_action_rate",
        toolId,
        callsThisTurn: count,
        threshold: t.maxDestructiveCallsPerTurn,
      }
    : null;
}

export function detectToolDiversitySpike(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  return m.distinctToolsThisTurn.size > t.maxDistinctToolsPerTurn
    ? {
        kind: "tool_diversity_spike",
        distinctToolCount: m.distinctToolsThisTurn.size,
        threshold: t.maxDistinctToolsPerTurn,
      }
    : null;
}

export function detectToolPingPong(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  if (m.pingPongAltCount <= t.maxPingPongCycles) return null;
  if (m.lastToolId === null || m.prevToolId === null) return null;
  return {
    kind: "tool_ping_pong",
    toolIdA: m.prevToolId,
    toolIdB: m.lastToolId,
    altCount: m.pingPongAltCount,
    threshold: t.maxPingPongCycles,
  };
}

export function detectSessionDurationExceeded(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
  now: number,
): AnomalyDetail | null {
  const dur = now - m.startedAt;
  return dur > t.maxSessionDurationMs
    ? {
        kind: "session_duration_exceeded",
        durationMs: dur,
        threshold: t.maxSessionDurationMs,
      }
    : null;
}

export function detectDelegationDepthExceeded(
  agentDepth: number,
  t: AgentMonitorThresholds,
  spawnToolId: string,
): AnomalyDetail | null {
  return agentDepth >= t.maxDelegationDepth
    ? {
        kind: "delegation_depth_exceeded",
        currentDepth: agentDepth,
        maxDepth: t.maxDelegationDepth,
        spawnToolId,
      }
    : null;
}

export function detectModelLatencyAnomaly(
  latencyMs: number,
  stats: LatencyStats,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  if (stats.count < t.minLatencySamples) return null;
  const threshold = stats.mean + t.latencyAnomalyFactor * stats.stddev;
  return latencyMs > threshold
    ? {
        kind: "model_latency_anomaly",
        latencyMs,
        mean: stats.mean,
        stddev: stats.stddev,
        factor: t.latencyAnomalyFactor,
      }
    : null;
}

export function detectTokenSpike(
  outputTokens: number,
  stats: LatencyStats,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  if (stats.count < t.minLatencySamples) return null;
  const threshold = stats.mean + t.tokenSpikeAnomalyFactor * stats.stddev;
  return outputTokens > threshold
    ? {
        kind: "token_spike",
        outputTokens,
        mean: stats.mean,
        stddev: stats.stddev,
        factor: t.tokenSpikeAnomalyFactor,
      }
    : null;
}

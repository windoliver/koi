import type { AnomalySignal, Result, SessionId } from "@koi/core";
import type { SessionMetricsSummary } from "./types.js";

export interface AgentMonitorThresholds {
  readonly maxToolCallsPerTurn: number;
  readonly maxErrorCallsPerSession: number;
  readonly maxConsecutiveRepeatCalls: number;
  readonly maxDeniedCallsPerSession: number;
  readonly latencyAnomalyFactor: number;
  readonly minLatencySamples: number;
  readonly maxDestructiveCallsPerTurn: number;
  readonly tokenSpikeAnomalyFactor: number;
  readonly maxDistinctToolsPerTurn: number;
  readonly maxPingPongCycles: number;
  readonly maxSessionDurationMs: number;
  readonly maxDelegationDepth: number;
}

export const DEFAULT_THRESHOLDS: AgentMonitorThresholds = {
  maxToolCallsPerTurn: 20,
  maxErrorCallsPerSession: 10,
  maxConsecutiveRepeatCalls: 5,
  maxDeniedCallsPerSession: 3,
  latencyAnomalyFactor: 3,
  minLatencySamples: 5,
  maxDestructiveCallsPerTurn: 3,
  tokenSpikeAnomalyFactor: 3,
  maxDistinctToolsPerTurn: 15,
  maxPingPongCycles: 4,
  maxSessionDurationMs: 300_000,
  maxDelegationDepth: 3,
};

export interface AgentMonitorConfig {
  readonly thresholds?: Partial<AgentMonitorThresholds>;
  readonly objectives?: readonly string[];
  readonly goalDrift?: {
    readonly threshold?: number;
    readonly scorer?: (
      toolIds: readonly string[],
      objectives: readonly string[],
    ) => number | Promise<number>;
    /**
     * Maximum time (ms) onSessionEnd will wait for in-flight async scorers
     * before exporting metrics. Late results after this budget are dropped
     * and reported via onAnomalyError as a synthetic "timed_out" signal so
     * operators know coverage was lost. Default: 100ms.
     */
    readonly shutdownTimeoutMs?: number;
  };
  readonly destructiveToolIds?: readonly string[];
  readonly spawnToolIds?: readonly string[];
  readonly agentDepth?: number;
  readonly onAnomaly?: (signal: AnomalySignal) => void | Promise<void>;
  readonly onAnomalyError?: (err: unknown, signal: AnomalySignal) => void;
  readonly onMetrics?: (sessionId: SessionId, summary: SessionMetricsSummary) => void;
}

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isFiniteAtLeast(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min;
}

export function validateAgentMonitorConfig(raw: unknown): Result<AgentMonitorConfig> {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config must be an object", retryable: false },
    };
  }
  const c = raw as AgentMonitorConfig;
  const t = c.thresholds;
  if (t !== undefined) {
    const pairs: ReadonlyArray<readonly [string, unknown, number]> = [
      ["maxToolCallsPerTurn", t.maxToolCallsPerTurn, 0],
      ["maxErrorCallsPerSession", t.maxErrorCallsPerSession, 0],
      ["maxConsecutiveRepeatCalls", t.maxConsecutiveRepeatCalls, 0],
      ["maxDeniedCallsPerSession", t.maxDeniedCallsPerSession, 0],
      ["latencyAnomalyFactor", t.latencyAnomalyFactor, 1],
      ["minLatencySamples", t.minLatencySamples, 1],
      ["maxDestructiveCallsPerTurn", t.maxDestructiveCallsPerTurn, 0],
      ["tokenSpikeAnomalyFactor", t.tokenSpikeAnomalyFactor, 1],
      ["maxDistinctToolsPerTurn", t.maxDistinctToolsPerTurn, 0],
      ["maxPingPongCycles", t.maxPingPongCycles, 0],
      ["maxSessionDurationMs", t.maxSessionDurationMs, 0],
      ["maxDelegationDepth", t.maxDelegationDepth, 0],
    ];
    for (const [name, val, min] of pairs) {
      if (val !== undefined && !isFiniteAtLeast(val, min)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `thresholds.${name} must be a finite number >= ${min}`,
            retryable: false,
          },
        };
      }
    }
  }
  if (c.goalDrift?.threshold !== undefined) {
    const x = c.goalDrift.threshold;
    if (typeof x !== "number" || x < 0 || x > 1) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "goalDrift.threshold must be in [0, 1]",
          retryable: false,
        },
      };
    }
  }
  if (c.goalDrift?.shutdownTimeoutMs !== undefined && !isFiniteNonNeg(c.goalDrift.shutdownTimeoutMs)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "goalDrift.shutdownTimeoutMs must be a non-negative finite number",
        retryable: false,
      },
    };
  }
  if (
    c.objectives !== undefined &&
    !c.objectives.every((s) => typeof s === "string" && s.length > 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "objectives must be an array of non-empty strings",
        retryable: false,
      },
    };
  }
  if (c.agentDepth !== undefined && !isFiniteNonNeg(c.agentDepth)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "agentDepth must be a non-negative finite number",
        retryable: false,
      },
    };
  }
  return { ok: true, value: c };
}

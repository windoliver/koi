/**
 * AgentMonitorConfig and validation.
 */

import type { SessionId } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { AnomalySignal, SessionMetricsSummary } from "./types.js";

export interface AgentMonitorConfig {
  readonly thresholds?: {
    readonly maxToolCallsPerTurn?: number;
    readonly maxErrorCallsPerSession?: number;
    readonly maxConsecutiveRepeatCalls?: number;
    readonly maxDeniedCallsPerSession?: number;
    readonly latencyAnomalyFactor?: number;
    readonly minLatencySamples?: number;
    /** Gap 1: max destructive/irreversible tool calls per turn before firing. */
    readonly maxDestructiveCallsPerTurn?: number;
    /** Gap 2: token spike factor (mean + N*stddev). Shares minLatencySamples warmup. */
    readonly tokenSpikeAnomalyFactor?: number;
    /** Gap 3: max distinct tool IDs callable in one turn before sweep is flagged. */
    readonly maxDistinctToolsPerTurn?: number;
    /** Gap A: max alternation count between two tools before ping-pong is flagged. */
    readonly maxPingPongCycles?: number;
    /** Gap B: max session wall-clock duration in milliseconds before firing. */
    readonly maxSessionDurationMs?: number;
    /**
     * Phase 2: max process-tree depth from which an agent may spawn sub-agents.
     * Requires agentDepth + spawnToolIds to be configured; disabled if either is absent.
     */
    readonly maxDelegationDepth?: number;
  };
  /**
   * Gap 1: set of toolIds classified as irreversible (delete, send, publish, transfer…).
   * Any tool in this set increments a separate counter checked against maxDestructiveCallsPerTurn.
   * An empty or absent set disables the signal.
   */
  readonly destructiveToolIds?: readonly string[];
  /**
   * Phase 2: this agent's current process-tree depth (0 = root copilot, 1 = first sub-agent…).
   * Must be set together with spawnToolIds for delegation_depth_exceeded to fire.
   * Absent or undefined disables the signal.
   */
  readonly agentDepth?: number;
  /**
   * Phase 2: tool IDs that spawn sub-agents (e.g. ["forge_agent"]).
   * An empty or absent array disables the signal even if agentDepth is set.
   * In Koi projects the L1 default is ["forge_agent"].
   */
  readonly spawnToolIds?: readonly string[];
  readonly onAnomaly?: (signal: AnomalySignal) => void | Promise<void>;
  readonly onAnomalyError?: (err: unknown, signal: AnomalySignal) => void;
  readonly onMetrics?: (sessionId: SessionId, summary: SessionMetricsSummary) => void;
}

export const DEFAULT_THRESHOLDS = {
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
} as const;

function validateNonNegativeInteger(value: unknown, name: string): KoiError | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    return {
      code: "VALIDATION",
      message: `${name} must be a non-negative integer`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  return null;
}

function validatePositiveNumber(value: unknown, name: string): KoiError | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return {
      code: "VALIDATION",
      message: `${name} must be a positive finite number`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  return null;
}

export function validateAgentMonitorConfig(config: unknown): Result<AgentMonitorConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (c.destructiveToolIds !== undefined) {
    if (!Array.isArray(c.destructiveToolIds)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "destructiveToolIds must be an array of strings",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    for (const id of c.destructiveToolIds as unknown[]) {
      if (typeof id !== "string") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "destructiveToolIds must be an array of strings",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  const agentDepthErr = validateNonNegativeInteger(c.agentDepth, "agentDepth");
  if (agentDepthErr !== null) return { ok: false, error: agentDepthErr };

  if (c.spawnToolIds !== undefined) {
    if (!Array.isArray(c.spawnToolIds)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "spawnToolIds must be an array of strings",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    for (const id of c.spawnToolIds as unknown[]) {
      if (typeof id !== "string") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "spawnToolIds must be an array of strings",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  if (c.onAnomaly !== undefined && typeof c.onAnomaly !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "onAnomaly must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.onAnomalyError !== undefined && typeof c.onAnomalyError !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "onAnomalyError must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.onMetrics !== undefined && typeof c.onMetrics !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "onMetrics must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.thresholds !== null && c.thresholds !== undefined) {
    if (typeof c.thresholds !== "object") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "thresholds must be an object",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    const t = c.thresholds as Record<string, unknown>;
    const numericFields = [
      "maxToolCallsPerTurn",
      "maxErrorCallsPerSession",
      "maxConsecutiveRepeatCalls",
      "maxDeniedCallsPerSession",
      "latencyAnomalyFactor",
      "minLatencySamples",
      "maxDestructiveCallsPerTurn",
      "tokenSpikeAnomalyFactor",
      "maxDistinctToolsPerTurn",
      "maxPingPongCycles",
      "maxSessionDurationMs",
      "maxDelegationDepth",
    ] as const;
    for (const field of numericFields) {
      const err = validatePositiveNumber(t[field], `thresholds.${field}`);
      if (err !== null) {
        return { ok: false, error: err };
      }
    }
  }

  return { ok: true, value: config as AgentMonitorConfig };
}

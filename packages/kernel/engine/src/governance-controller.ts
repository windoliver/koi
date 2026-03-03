/**
 * Governance controller — unified cybernetic controller implementation.
 *
 * Creates a closure-based controller with built-in sensors for spawn depth,
 * spawn count, turns, tokens, duration, and error rate. L2 packages contribute
 * additional variables via the GovernanceVariableContributor pattern.
 *
 * The builder interface (register/seal) is L1-only. After seal(), only the
 * runtime GovernanceController interface is available.
 */

import type {
  GovernanceCheck,
  GovernanceController,
  GovernanceEvent,
  GovernanceSnapshot,
  GovernanceVariable,
  SensorReading,
} from "@koi/core";
import { GOVERNANCE_VARIABLES } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createRollingWindow } from "./rolling-window.js";
import type { GovernanceConfig } from "./types.js";
import { createDefaultGovernanceConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Builder interface (L1-only, not exported to L0)
// ---------------------------------------------------------------------------

export interface GovernanceControllerBuilder extends GovernanceController {
  readonly register: (variable: GovernanceVariable) => void;
  readonly seal: () => void;
  readonly sealed: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGovernanceController(
  config?: Partial<GovernanceConfig> | undefined,
  options?: { readonly agentDepth?: number | undefined } | undefined,
): GovernanceControllerBuilder {
  const resolved = createDefaultGovernanceConfig(config);
  const agentDepth = options?.agentDepth ?? 0;

  const variables = new Map<string, GovernanceVariable>();
  // let justified: mutable sealed flag
  let isSealed = false;

  // --- Mutable counters (single-threaded, closure-scoped) ---
  // let justified: mutable counters tracking agent activity
  let turnCount = 0;
  let tokenUsage = 0;
  let spawnCount = 0;
  const startedAt = Date.now();

  // Cost tracking
  const costConfig = resolved.cost;
  // let justified: mutable accumulated cost in USD
  let accumulatedCostUsd = 0;

  // Error rate tracking
  const errorRateConfig = resolved.errorRate;
  const errorWindow = createRollingWindow(errorRateConfig.windowMs);
  // let justified: mutable total tool call counter for error rate denominator
  let totalToolCalls = 0;

  // --- Helper: create a GovernanceCheck for a variable violation ---
  function failCheck(variable: GovernanceVariable, reason: string): GovernanceCheck {
    return {
      ok: false,
      variable: variable.name,
      reason,
      retryable: variable.retryable,
    };
  }

  // --- Built-in variables ---

  const spawnDepthVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.SPAWN_DEPTH,
    read: () => agentDepth,
    limit: resolved.spawn.maxDepth,
    retryable: false,
    description: "Maximum spawn tree depth",
    check(): GovernanceCheck {
      // Depth > limit is a violation (depth equal to max IS allowed)
      if (agentDepth > resolved.spawn.maxDepth) {
        return failCheck(
          spawnDepthVar,
          `Spawn depth ${agentDepth} exceeds max ${resolved.spawn.maxDepth}`,
        );
      }
      return { ok: true };
    },
  };

  const spawnCountVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.SPAWN_COUNT,
    read: () => spawnCount,
    limit: resolved.spawn.maxFanOut,
    retryable: true,
    description: "Maximum concurrent child agents",
    check(): GovernanceCheck {
      // Reaching limit IS a violation
      if (spawnCount >= resolved.spawn.maxFanOut) {
        return failCheck(
          spawnCountVar,
          `Spawn count ${spawnCount} reached limit ${resolved.spawn.maxFanOut}`,
        );
      }
      return { ok: true };
    },
  };

  const turnCountVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.TURN_COUNT,
    read: () => turnCount,
    limit: resolved.iteration.maxTurns,
    retryable: false,
    description: "Maximum turns per session",
    check(): GovernanceCheck {
      if (turnCount >= resolved.iteration.maxTurns) {
        return failCheck(
          turnCountVar,
          `Turn count ${turnCount} reached limit ${resolved.iteration.maxTurns}`,
        );
      }
      return { ok: true };
    },
  };

  const tokenUsageVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.TOKEN_USAGE,
    read: () => tokenUsage,
    limit: resolved.iteration.maxTokens,
    retryable: false,
    description: "Maximum total tokens per session",
    check(): GovernanceCheck {
      if (tokenUsage >= resolved.iteration.maxTokens) {
        return failCheck(
          tokenUsageVar,
          `Token usage ${tokenUsage} reached limit ${resolved.iteration.maxTokens}`,
        );
      }
      return { ok: true };
    },
  };

  const durationVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.DURATION_MS,
    read: () => Date.now() - startedAt,
    limit: resolved.iteration.maxDurationMs,
    retryable: false,
    description: "Maximum session duration in milliseconds",
    check(): GovernanceCheck {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= resolved.iteration.maxDurationMs) {
        return failCheck(
          durationVar,
          `Duration ${elapsed}ms reached limit ${resolved.iteration.maxDurationMs}ms`,
        );
      }
      return { ok: true };
    },
  };

  const errorRateVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.ERROR_RATE,
    read: () => (totalToolCalls > 0 ? errorWindow.count(Date.now()) / totalToolCalls : 0),
    limit: errorRateConfig.threshold,
    retryable: true,
    description: "Tool error rate within rolling time window",
    check(): GovernanceCheck {
      if (totalToolCalls <= 0) return { ok: true };
      const rate = errorWindow.count(Date.now()) / totalToolCalls;
      if (rate >= errorRateConfig.threshold) {
        return failCheck(
          errorRateVar,
          `Error rate ${rate.toFixed(2)} reached threshold ${errorRateConfig.threshold}`,
        );
      }
      return { ok: true };
    },
  };

  const costUsdVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.COST_USD,
    read: () => accumulatedCostUsd,
    limit: costConfig.maxCostUsd,
    retryable: false,
    description: "Maximum session cost in USD",
    check(): GovernanceCheck {
      // Skip check when cost tracking is disabled (maxCostUsd === 0)
      if (costConfig.maxCostUsd <= 0) return { ok: true };
      if (accumulatedCostUsd >= costConfig.maxCostUsd) {
        return failCheck(
          costUsdVar,
          `Cost $${accumulatedCostUsd.toFixed(4)} reached limit $${costConfig.maxCostUsd.toFixed(4)}`,
        );
      }
      return { ok: true };
    },
  };

  // Register built-in variables
  variables.set(spawnDepthVar.name, spawnDepthVar);
  variables.set(spawnCountVar.name, spawnCountVar);
  variables.set(turnCountVar.name, turnCountVar);
  variables.set(tokenUsageVar.name, tokenUsageVar);
  variables.set(durationVar.name, durationVar);
  variables.set(errorRateVar.name, errorRateVar);
  variables.set(costUsdVar.name, costUsdVar);

  // --- GovernanceController methods ---

  function check(variable: string): GovernanceCheck {
    const v = variables.get(variable);
    if (v === undefined) {
      return {
        ok: false,
        variable,
        reason: `Unknown governance variable: "${variable}"`,
        retryable: false,
      };
    }
    return v.check();
  }

  function checkAll(): GovernanceCheck {
    for (const v of variables.values()) {
      const result = v.check();
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  function record(event: GovernanceEvent): void {
    switch (event.kind) {
      case "turn":
        turnCount++;
        break;
      case "spawn":
        spawnCount++;
        break;
      case "spawn_release":
        spawnCount = Math.max(0, spawnCount - 1);
        break;
      case "forge":
        // Forge events tracked by L2-contributed variables
        break;
      case "token_usage":
        tokenUsage += event.count;
        // Accumulate cost when input/output breakdown is provided
        if (event.inputTokens !== undefined && event.outputTokens !== undefined) {
          accumulatedCostUsd +=
            event.inputTokens * costConfig.costPerInputToken +
            event.outputTokens * costConfig.costPerOutputToken;
        }
        break;
      case "tool_error":
        errorWindow.record(Date.now());
        totalToolCalls++;
        break;
      case "tool_success":
        totalToolCalls++;
        break;
    }
  }

  function computeReading(v: GovernanceVariable): SensorReading {
    const current = v.read();
    return {
      name: v.name,
      current,
      limit: v.limit,
      utilization: v.limit > 0 ? Math.min(1, current / v.limit) : 0,
    };
  }

  function snapshot(): GovernanceSnapshot {
    const readings: SensorReading[] = [];
    const violations: string[] = [];
    for (const v of variables.values()) {
      readings.push(computeReading(v));
      const result = v.check();
      if (!result.ok) {
        violations.push(result.variable);
      }
    }
    return Object.freeze({
      timestamp: Date.now(),
      readings: Object.freeze(readings),
      healthy: violations.length === 0,
      violations: Object.freeze(violations),
    });
  }

  function reading(variable: string): SensorReading | undefined {
    const v = variables.get(variable);
    if (v === undefined) return undefined;
    return computeReading(v);
  }

  // --- Builder methods (L1-only) ---

  function register(variable: GovernanceVariable): void {
    if (isSealed) {
      throw KoiRuntimeError.from(
        "VALIDATION",
        `Cannot register variable "${variable.name}" — controller is sealed`,
        { context: { variable: variable.name } },
      );
    }
    variables.set(variable.name, variable);
  }

  function seal(): void {
    isSealed = true;
  }

  return {
    check,
    checkAll,
    record,
    snapshot,
    variables: () => variables as ReadonlyMap<string, GovernanceVariable>,
    reading,
    register,
    seal,
    get sealed() {
      return isSealed;
    },
  };
}

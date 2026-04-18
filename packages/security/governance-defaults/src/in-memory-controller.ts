import type {
  GovernanceCheck,
  GovernanceController,
  GovernanceEvent,
  GovernanceSnapshot,
  GovernanceVariable,
  SensorReading,
} from "@koi/core/governance";
import { GOVERNANCE_VARIABLES } from "@koi/core/governance";

export interface InMemoryControllerConfig {
  readonly tokenUsageLimit?: number | undefined;
  readonly costUsdLimit?: number | undefined;
  readonly turnCountLimit?: number | undefined;
  readonly spawnDepthLimit?: number | undefined;
  readonly spawnCountLimit?: number | undefined;
  readonly durationMsLimit?: number | undefined;
  readonly forgeDepthLimit?: number | undefined;
  readonly forgeBudgetLimit?: number | undefined;
  readonly errorRateLimit?: number | undefined;
  readonly contextOccupancyLimit?: number | undefined;
  readonly errorRateWindow?: number | undefined;
  /** Minimum sample size before error_rate gates start firing. Default: 3. */
  readonly errorRateMinSamples?: number | undefined;
  /** Depth of THIS controller's agent in the spawn tree. Default: 0. */
  readonly agentDepth?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_ERROR_RATE_WINDOW = 20;
const DEFAULT_ERROR_RATE_MIN_SAMPLES = 3;
const INF = Number.POSITIVE_INFINITY;

interface MutableState {
  tokenUsed: number;
  costUsed: number;
  turnCount: number;
  /** Concurrent live children — increments on spawn, decrements on spawn_release. */
  spawnCount: number;
  iterationStart: number;
  forgeBudget: number;
  readonly toolOutcomes: boolean[];
  contextOccupancy: number;
}

function computeUtilization(current: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(1, current / limit);
}

export function createInMemoryController(config: InMemoryControllerConfig): GovernanceController {
  const now = config.now ?? Date.now;
  const errorRateWindow = config.errorRateWindow ?? DEFAULT_ERROR_RATE_WINDOW;
  const errorRateMinSamples = config.errorRateMinSamples ?? DEFAULT_ERROR_RATE_MIN_SAMPLES;
  const agentDepth = config.agentDepth ?? 0;

  const tokenUsageLimit = config.tokenUsageLimit ?? INF;
  const costUsdLimit = config.costUsdLimit ?? INF;
  const turnCountLimit = config.turnCountLimit ?? INF;
  const spawnDepthLimit = config.spawnDepthLimit ?? INF;
  const spawnCountLimit = config.spawnCountLimit ?? INF;
  const durationMsLimit = config.durationMsLimit ?? INF;
  const forgeDepthLimit = config.forgeDepthLimit ?? INF;
  const forgeBudgetLimit = config.forgeBudgetLimit ?? INF;
  const errorRateLimit = config.errorRateLimit ?? 1;
  const contextOccupancyLimit = config.contextOccupancyLimit ?? 1;

  const state: MutableState = {
    tokenUsed: 0,
    costUsed: 0,
    turnCount: 0,
    spawnCount: 0,
    iterationStart: now(),
    forgeBudget: 0,
    toolOutcomes: [],
    contextOccupancy: 0,
  };

  function errorRate(): number {
    if (state.toolOutcomes.length === 0) return 0;
    let errs = 0;
    for (const ok of state.toolOutcomes) if (!ok) errs += 1;
    return errs / state.toolOutcomes.length;
  }

  function fail(variable: string, reason: string, retryable: boolean): GovernanceCheck {
    return { ok: false, variable, reason, retryable };
  }

  // --- Per-variable definitions ---
  //
  // Semantics follow `@koi/engine-reconcile`'s governance-controller:
  //   * bounded counters and rates fail when current REACHES the limit (`>=`),
  //     so the operator-visible limit is an inclusive ceiling.
  //   * `spawn_depth` fails only above the limit (`>`) because depth-at-limit
  //     is the last valid frame; `spawn_depth` sensor models this controller's
  //     own agent depth (fixed at construction), not child spawn events.
  //   * `retryable` differs per variable — `spawn_count` / `error_rate` are
  //     transient (caller can back off), everything else is terminal.

  const spawnDepthVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.SPAWN_DEPTH,
    read: () => agentDepth,
    limit: spawnDepthLimit,
    retryable: false,
    description: "Depth of this controller's agent in the spawn tree",
    check: (): GovernanceCheck =>
      agentDepth > spawnDepthLimit
        ? fail(
            GOVERNANCE_VARIABLES.SPAWN_DEPTH,
            `spawn_depth ${agentDepth} exceeds limit ${spawnDepthLimit}`,
            false,
          )
        : { ok: true },
  };

  const spawnCountVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.SPAWN_COUNT,
    read: () => state.spawnCount,
    limit: spawnCountLimit,
    retryable: true,
    description: "Concurrent live child agents — retryable once a release reclaims capacity",
    check: (): GovernanceCheck =>
      state.spawnCount >= spawnCountLimit
        ? fail(
            GOVERNANCE_VARIABLES.SPAWN_COUNT,
            `spawn_count ${state.spawnCount} reached limit ${spawnCountLimit}`,
            true,
          )
        : { ok: true },
  };

  const turnCountVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.TURN_COUNT,
    read: () => state.turnCount,
    limit: turnCountLimit,
    retryable: false,
    description: "Turns this iteration (reset by iteration_reset/session_reset)",
    check: (): GovernanceCheck =>
      state.turnCount >= turnCountLimit
        ? fail(
            GOVERNANCE_VARIABLES.TURN_COUNT,
            `turn_count ${state.turnCount} reached limit ${turnCountLimit}`,
            false,
          )
        : { ok: true },
  };

  const tokenUsageVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.TOKEN_USAGE,
    read: () => state.tokenUsed,
    limit: tokenUsageLimit,
    retryable: false,
    description: "Cumulative tokens — runtime-lifetime (not reset)",
    check: (): GovernanceCheck =>
      state.tokenUsed >= tokenUsageLimit
        ? fail(
            GOVERNANCE_VARIABLES.TOKEN_USAGE,
            `token_usage ${state.tokenUsed} reached limit ${tokenUsageLimit}`,
            false,
          )
        : { ok: true },
  };

  const durationVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.DURATION_MS,
    read: () => now() - state.iterationStart,
    limit: durationMsLimit,
    retryable: false,
    description: "Wall-clock ms this iteration (reset by iteration_reset/session_reset)",
    check: (): GovernanceCheck => {
      const elapsed = now() - state.iterationStart;
      return elapsed >= durationMsLimit
        ? fail(
            GOVERNANCE_VARIABLES.DURATION_MS,
            `duration_ms ${elapsed} reached limit ${durationMsLimit}`,
            false,
          )
        : { ok: true };
    },
  };

  const errorRateVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.ERROR_RATE,
    read: errorRate,
    limit: errorRateLimit,
    retryable: true,
    description: "Rolling tool error rate — retryable (back off and retry)",
    check: (): GovernanceCheck => {
      if (state.toolOutcomes.length < errorRateMinSamples) return { ok: true };
      const rate = errorRate();
      return rate >= errorRateLimit
        ? fail(
            GOVERNANCE_VARIABLES.ERROR_RATE,
            `error_rate ${rate.toFixed(2)} reached limit ${errorRateLimit}`,
            true,
          )
        : { ok: true };
    },
  };

  const costUsdVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.COST_USD,
    read: () => state.costUsed,
    limit: costUsdLimit,
    retryable: false,
    description: "Cumulative cost USD — runtime-lifetime (not reset)",
    check: (): GovernanceCheck =>
      state.costUsed >= costUsdLimit
        ? fail(
            GOVERNANCE_VARIABLES.COST_USD,
            `cost_usd ${state.costUsed.toFixed(4)} reached limit ${costUsdLimit.toFixed(4)}`,
            false,
          )
        : { ok: true },
  };

  const forgeDepthVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.FORGE_DEPTH,
    read: () => state.forgeBudget,
    limit: forgeDepthLimit,
    retryable: false,
    description:
      "Forge nesting — tracked as cumulative count in the default controller because the L0 GovernanceEvent union has no forge_release event",
    check: (): GovernanceCheck =>
      state.forgeBudget >= forgeDepthLimit
        ? fail(
            GOVERNANCE_VARIABLES.FORGE_DEPTH,
            `forge_depth ${state.forgeBudget} reached limit ${forgeDepthLimit}`,
            false,
          )
        : { ok: true },
  };

  const forgeBudgetVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.FORGE_BUDGET,
    read: () => state.forgeBudget,
    limit: forgeBudgetLimit,
    retryable: false,
    description: "Cumulative forge calls",
    check: (): GovernanceCheck =>
      state.forgeBudget >= forgeBudgetLimit
        ? fail(
            GOVERNANCE_VARIABLES.FORGE_BUDGET,
            `forge_budget ${state.forgeBudget} reached limit ${forgeBudgetLimit}`,
            false,
          )
        : { ok: true },
  };

  const contextOccupancyVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY,
    read: () => state.contextOccupancy,
    limit: contextOccupancyLimit,
    retryable: true,
    description:
      "Context window fraction — no L0 event sets this; hosts with a custom setter may override",
    check: (): GovernanceCheck =>
      state.contextOccupancy >= contextOccupancyLimit
        ? fail(
            GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY,
            `context_occupancy ${state.contextOccupancy.toFixed(2)} reached limit ${contextOccupancyLimit.toFixed(2)}`,
            true,
          )
        : { ok: true },
  };

  const variables: ReadonlyMap<string, GovernanceVariable> = new Map([
    [spawnDepthVar.name, spawnDepthVar],
    [spawnCountVar.name, spawnCountVar],
    [turnCountVar.name, turnCountVar],
    [tokenUsageVar.name, tokenUsageVar],
    [durationVar.name, durationVar],
    [errorRateVar.name, errorRateVar],
    [costUsdVar.name, costUsdVar],
    [forgeDepthVar.name, forgeDepthVar],
    [forgeBudgetVar.name, forgeBudgetVar],
    [contextOccupancyVar.name, contextOccupancyVar],
  ]);

  function record(event: GovernanceEvent): void {
    switch (event.kind) {
      case "token_usage": {
        const tokens =
          event.inputTokens !== undefined || event.outputTokens !== undefined
            ? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
            : event.count;
        state.tokenUsed += tokens;
        // Trust boundary: `event.costUsd` is pre-computed by a CostCalculator the
        // host supplied. Reject NaN / negative so a buggy calculator cannot poison
        // `costUsed` and silently disable the spend cap (NaN comparisons always
        // return false; negatives would offset later spend). Invalid input is
        // simply dropped — the controller has no per-token fallback rates; hosts
        // that want fallback pricing should use a `CostCalculator` that never
        // throws.
        if (event.costUsd !== undefined && Number.isFinite(event.costUsd) && event.costUsd >= 0) {
          state.costUsed += event.costUsd;
        }
        return;
      }
      case "turn":
        state.turnCount += 1;
        return;
      case "spawn":
        // spawn_count tracks concurrent live children — depth is a property of
        // each controller (its own agentDepth), not a counter the parent mutates.
        state.spawnCount += 1;
        return;
      case "spawn_release":
        state.spawnCount = Math.max(0, state.spawnCount - 1);
        return;
      case "forge":
        state.forgeBudget += 1;
        return;
      case "tool_error":
        state.toolOutcomes.push(false);
        if (state.toolOutcomes.length > errorRateWindow) state.toolOutcomes.shift();
        return;
      case "tool_success":
        state.toolOutcomes.push(true);
        if (state.toolOutcomes.length > errorRateWindow) state.toolOutcomes.shift();
        return;
      case "iteration_reset":
        // L0 contract: reset per-iteration UX budgets (turn_count, duration_ms).
        // Token usage, cost, spawn counts, and error-rate windows survive.
        state.turnCount = 0;
        state.iterationStart = now();
        return;
      case "session_reset":
        // L0 contract: reset iteration counters AND rolling error-rate window so
        // a fresh conversation doesn't inherit tool-error history. Token usage,
        // cost, and spawn_count remain cumulative.
        state.turnCount = 0;
        state.iterationStart = now();
        state.toolOutcomes.length = 0;
        return;
    }
  }

  return {
    check: (variable: string): GovernanceCheck => {
      const v = variables.get(variable);
      if (v === undefined) return { ok: true };
      return v.check();
    },
    checkAll: (): GovernanceCheck => {
      for (const v of variables.values()) {
        const result = v.check();
        if (!result.ok) return result;
      }
      return { ok: true };
    },
    record,
    snapshot: (): GovernanceSnapshot => {
      const readings: SensorReading[] = [];
      const violations: string[] = [];
      for (const v of variables.values()) {
        const current = v.read();
        readings.push({
          name: v.name,
          current,
          limit: v.limit,
          utilization: computeUtilization(current, v.limit),
        });
        const result = v.check();
        if (!result.ok) violations.push(result.variable);
      }
      return {
        timestamp: now(),
        readings,
        healthy: violations.length === 0,
        violations,
      };
    },
    variables: (): ReadonlyMap<string, GovernanceVariable> => variables,
    reading: (variable: string): SensorReading | undefined => {
      const v = variables.get(variable);
      if (v === undefined) return undefined;
      const current = v.read();
      return {
        name: v.name,
        current,
        limit: v.limit,
        utilization: computeUtilization(current, v.limit),
      };
    },
  };
}

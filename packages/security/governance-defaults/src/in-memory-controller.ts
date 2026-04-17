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
  readonly now?: (() => number) | undefined;
}

const DEFAULT_ERROR_RATE_WINDOW = 20;
const INF = Number.POSITIVE_INFINITY;

interface MutableState {
  tokenUsed: number;
  costUsed: number;
  turnCount: number;
  spawnDepth: number;
  spawnCount: number;
  iterationStart: number;
  forgeDepth: number;
  forgeBudget: number;
  readonly toolOutcomes: boolean[];
  contextOccupancy: number;
}

function computeErrorRate(outcomes: readonly boolean[]): number {
  if (outcomes.length === 0) return 0;
  let errs = 0;
  for (const ok of outcomes) if (!ok) errs += 1;
  return errs / outcomes.length;
}

function computeUtilization(current: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return current / limit;
}

export function createInMemoryController(config: InMemoryControllerConfig): GovernanceController {
  const now = config.now ?? Date.now;
  const errorRateWindow = config.errorRateWindow ?? DEFAULT_ERROR_RATE_WINDOW;

  const limits = {
    [GOVERNANCE_VARIABLES.TOKEN_USAGE]: config.tokenUsageLimit ?? INF,
    [GOVERNANCE_VARIABLES.COST_USD]: config.costUsdLimit ?? INF,
    [GOVERNANCE_VARIABLES.TURN_COUNT]: config.turnCountLimit ?? INF,
    [GOVERNANCE_VARIABLES.SPAWN_DEPTH]: config.spawnDepthLimit ?? INF,
    [GOVERNANCE_VARIABLES.SPAWN_COUNT]: config.spawnCountLimit ?? INF,
    [GOVERNANCE_VARIABLES.DURATION_MS]: config.durationMsLimit ?? INF,
    [GOVERNANCE_VARIABLES.FORGE_DEPTH]: config.forgeDepthLimit ?? INF,
    [GOVERNANCE_VARIABLES.FORGE_BUDGET]: config.forgeBudgetLimit ?? INF,
    [GOVERNANCE_VARIABLES.ERROR_RATE]: config.errorRateLimit ?? 1,
    [GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY]: config.contextOccupancyLimit ?? 1,
  } as const;

  const state: MutableState = {
    tokenUsed: 0,
    costUsed: 0,
    turnCount: 0,
    spawnDepth: 0,
    spawnCount: 0,
    iterationStart: now(),
    forgeDepth: 0,
    forgeBudget: 0,
    toolOutcomes: [],
    contextOccupancy: 0,
  };

  const readers: Readonly<Record<string, () => number>> = {
    [GOVERNANCE_VARIABLES.TOKEN_USAGE]: () => state.tokenUsed,
    [GOVERNANCE_VARIABLES.COST_USD]: () => state.costUsed,
    [GOVERNANCE_VARIABLES.TURN_COUNT]: () => state.turnCount,
    [GOVERNANCE_VARIABLES.SPAWN_DEPTH]: () => state.spawnDepth,
    [GOVERNANCE_VARIABLES.SPAWN_COUNT]: () => state.spawnCount,
    [GOVERNANCE_VARIABLES.DURATION_MS]: () => now() - state.iterationStart,
    [GOVERNANCE_VARIABLES.FORGE_DEPTH]: () => state.forgeDepth,
    [GOVERNANCE_VARIABLES.FORGE_BUDGET]: () => state.forgeBudget,
    [GOVERNANCE_VARIABLES.ERROR_RATE]: () => computeErrorRate(state.toolOutcomes),
    [GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY]: () => state.contextOccupancy,
  };

  function readingFor(name: string): SensorReading | undefined {
    const read = readers[name];
    const limit = limits[name as keyof typeof limits];
    if (read === undefined || limit === undefined) return undefined;
    const current = read();
    return { name, current, limit, utilization: computeUtilization(current, limit) };
  }

  function checkVariable(name: string): GovernanceCheck {
    const reading = readingFor(name);
    if (reading === undefined) return { ok: true };
    if (reading.current > reading.limit) {
      return {
        ok: false,
        variable: name,
        reason: `${name} exceeded limit (${reading.current} > ${reading.limit})`,
        retryable: false,
      };
    }
    return { ok: true };
  }

  const variables: ReadonlyMap<string, GovernanceVariable> = new Map(
    Object.keys(readers).map((name) => [
      name,
      {
        name,
        read: readers[name] ?? ((): number => 0),
        limit: limits[name as keyof typeof limits] ?? INF,
        check: (): GovernanceCheck => checkVariable(name),
        retryable: false,
      },
    ]),
  );

  function record(event: GovernanceEvent): void {
    switch (event.kind) {
      case "token_usage": {
        const tokens =
          event.inputTokens !== undefined || event.outputTokens !== undefined
            ? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
            : event.count;
        state.tokenUsed += tokens;
        if (event.costUsd !== undefined) state.costUsed += event.costUsd;
        return;
      }
      case "turn":
        state.turnCount += 1;
        return;
      case "spawn":
        state.spawnDepth = event.depth;
        state.spawnCount += 1;
        return;
      case "spawn_release":
        state.spawnDepth = Math.max(0, state.spawnDepth - 1);
        return;
      case "forge":
        state.forgeDepth += 1;
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
        state.turnCount = 0;
        state.iterationStart = now();
        return;
      case "session_reset":
        state.turnCount = 0;
        state.iterationStart = now();
        state.toolOutcomes.length = 0;
        return;
    }
  }

  return {
    check: (variable: string): GovernanceCheck => checkVariable(variable),
    checkAll: (): GovernanceCheck => {
      for (const name of Object.keys(readers)) {
        const result = checkVariable(name);
        if (!result.ok) return result;
      }
      return { ok: true };
    },
    record,
    snapshot: (): GovernanceSnapshot => {
      const readings: SensorReading[] = [];
      const violations: string[] = [];
      for (const name of Object.keys(readers)) {
        const reading = readingFor(name);
        if (reading === undefined) continue;
        readings.push(reading);
        if (reading.current > reading.limit) violations.push(name);
      }
      return {
        timestamp: now(),
        readings,
        healthy: violations.length === 0,
        violations,
      };
    },
    variables: (): ReadonlyMap<string, GovernanceVariable> => variables,
    reading: (variable: string): SensorReading | undefined => readingFor(variable),
  };
}

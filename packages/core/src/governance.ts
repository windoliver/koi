/**
 * Governance contract — unified cybernetic controller types.
 *
 * Defines the sensor/setpoint model: each GovernanceVariable is one sensor
 * with one limit. The GovernanceController reads all sensors and produces
 * a GovernanceSnapshot. L2 packages contribute variables via the
 * GovernanceVariableContributor pattern.
 *
 * Exception: GOVERNANCE_VARIABLES is a pure readonly data constant derived
 * from L0 type definitions, codifying architecture-doc invariants with zero logic.
 *
 * Exception: governanceContributorToken() is a branded type constructor
 * (identity cast), permitted in L0 as a zero-logic operation for type safety.
 */

import type { SubsystemToken } from "./ecs.js";

// ---------------------------------------------------------------------------
// GovernanceCheck — generalized check result (replaces SpawnCheck)
// ---------------------------------------------------------------------------

export type GovernanceCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly variable: string;
      readonly reason: string;
      readonly retryable: boolean;
    };

// ---------------------------------------------------------------------------
// GovernanceVariable — one sensor + one setpoint
// ---------------------------------------------------------------------------

export interface GovernanceVariable {
  readonly name: string;
  readonly read: () => number;
  readonly limit: number;
  readonly check: () => GovernanceCheck;
  readonly retryable: boolean;
  readonly description?: string | undefined;
}

// ---------------------------------------------------------------------------
// SensorReading — point-in-time snapshot of a single variable
// ---------------------------------------------------------------------------

export interface SensorReading {
  readonly name: string;
  readonly current: number;
  readonly limit: number;
  readonly utilization: number;
}

// ---------------------------------------------------------------------------
// ContextPressureTrend — pressure growth over recent turns
// ---------------------------------------------------------------------------

export interface ContextPressureTrend {
  readonly growthPerTurn: number;
  readonly estimatedTurnsToCompaction: number;
  readonly sampleCount: number;
}

// ---------------------------------------------------------------------------
// GovernanceSnapshot — all variables at a point in time
// ---------------------------------------------------------------------------

export interface GovernanceSnapshot {
  readonly timestamp: number;
  readonly readings: readonly SensorReading[];
  readonly healthy: boolean;
  readonly violations: readonly string[];
}

// ---------------------------------------------------------------------------
// GovernanceEvent — events that update sensor state
// ---------------------------------------------------------------------------

export type GovernanceEvent =
  | { readonly kind: "turn" }
  | { readonly kind: "spawn"; readonly depth: number }
  | { readonly kind: "spawn_release" }
  | { readonly kind: "forge"; readonly toolName?: string | undefined }
  | {
      readonly kind: "token_usage";
      readonly count: number;
      readonly inputTokens?: number | undefined;
      readonly outputTokens?: number | undefined;
      readonly costUsd?: number | undefined;
    }
  | { readonly kind: "tool_error"; readonly toolName: string }
  | { readonly kind: "tool_success"; readonly toolName: string };

// ---------------------------------------------------------------------------
// GovernanceController — runtime interface (replaces GovernanceComponent)
// All I/O-capable methods return T | Promise<T> per SpawnLedger pattern
// ---------------------------------------------------------------------------

export interface GovernanceController {
  readonly check: (variable: string) => GovernanceCheck | Promise<GovernanceCheck>;
  readonly checkAll: () => GovernanceCheck | Promise<GovernanceCheck>;
  readonly record: (event: GovernanceEvent) => void | Promise<void>;
  readonly snapshot: () => GovernanceSnapshot | Promise<GovernanceSnapshot>;
  readonly variables: () => ReadonlyMap<string, GovernanceVariable>;
  readonly reading: (variable: string) => SensorReading | undefined;
}

// ---------------------------------------------------------------------------
// GovernanceVariableContributor — L2 packages declare variables via this
// ---------------------------------------------------------------------------

export interface GovernanceVariableContributor {
  readonly variables: () => readonly GovernanceVariable[];
}

// ---------------------------------------------------------------------------
// Well-known variable names
// ---------------------------------------------------------------------------

export const GOVERNANCE_VARIABLES: {
  readonly SPAWN_DEPTH: "spawn_depth";
  readonly SPAWN_COUNT: "spawn_count";
  readonly TURN_COUNT: "turn_count";
  readonly TOKEN_USAGE: "token_usage";
  readonly DURATION_MS: "duration_ms";
  readonly FORGE_DEPTH: "forge_depth";
  readonly FORGE_BUDGET: "forge_budget";
  readonly ERROR_RATE: "error_rate";
  readonly COST_USD: "cost_usd";
  readonly CONTEXT_OCCUPANCY: "context_occupancy";
} = {
  SPAWN_DEPTH: "spawn_depth",
  SPAWN_COUNT: "spawn_count",
  TURN_COUNT: "turn_count",
  TOKEN_USAGE: "token_usage",
  DURATION_MS: "duration_ms",
  FORGE_DEPTH: "forge_depth",
  FORGE_BUDGET: "forge_budget",
  ERROR_RATE: "error_rate",
  COST_USD: "cost_usd",
  CONTEXT_OCCUPANCY: "context_occupancy",
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// Contributor token factory (branded cast — sole runtime code)
// ---------------------------------------------------------------------------

/**
 * Create a SubsystemToken for a GovernanceVariableContributor.
 * L2 packages attach contributors under the "governance:contrib:<name>" prefix.
 * The L1 governance extension discovers all contributors via prefix query.
 */
export function governanceContributorToken(
  name: string,
): SubsystemToken<GovernanceVariableContributor> {
  return `governance:contrib:${name}` as SubsystemToken<GovernanceVariableContributor>;
}

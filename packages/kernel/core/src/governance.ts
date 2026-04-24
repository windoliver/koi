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
  /**
   * Refund one or more previously recorded turns.
   *
   * Useful when a host temporarily increments turn-count for internal
   * orchestration work (tool wrappers, retries, delegated internal loops)
   * that should not consume user-visible turn budget.
   */
  | { readonly kind: "turn_refund"; readonly count: number }
  | { readonly kind: "spawn"; readonly depth: number }
  | { readonly kind: "spawn_release" }
  | { readonly kind: "forge"; readonly toolName?: string | undefined }
  /**
   * Emitted when a forge compilation finishes (success, failure, or abort) to
   * decrement the concurrent `forge_depth` sensor. Must be paired with a prior
   * `forge` emit or the counter drifts. Same discipline as spawn/spawn_release.
   */
  | { readonly kind: "forge_release" }
  | {
      readonly kind: "token_usage";
      readonly count: number;
      readonly inputTokens?: number | undefined;
      readonly outputTokens?: number | undefined;
      readonly costUsd?: number | undefined;
    }
  | { readonly kind: "tool_error"; readonly toolName: string }
  | { readonly kind: "tool_success"; readonly toolName: string }
  /**
   * @deprecated Renamed to `run_reset` in #1939. Handled as a no-provenance run_reset for
   * one release so existing hosts that emit this event keep working. Remove in next major.
   */
  | { readonly kind: "iteration_reset" }
  /**
   * Emitted at the start of each `runtime.run()` when `resetBudgetPerRun: true`.
   * Resets per-run UX budgets — turn count and duration — so each `run()` call
   * gets a fresh model-call and wall-clock window. Token usage, cost, spawn counts,
   * and rolling error-rate windows are intentionally NOT reset (they back runtime-wide
   * spend/safety caps). The split lets interactive hosts give each user submit its own
   * turn/duration budget while keeping cumulative spend ceilings for the runtime lifetime.
   *
   * `source`     — who triggered the reset: "engine" (automatic), "host" (manual)
   * `boundaryId` — deterministic `${sessionId}:session:${cycleIndex}:run:${runIndex}`, unique
   *               across session rotations even when the host reuses the same session ID
   */
  | {
      readonly kind: "run_reset";
      /**
       * Optional for backward compatibility: controllers default to `"engine"` when absent.
       * Producers should always supply this to distinguish host-driven vs engine-driven resets.
       */
      readonly source?: "host" | "engine" | undefined;
      readonly reason?: string | undefined;
      /**
       * Optional for backward compatibility: controllers skip provenance logging when absent.
       */
      readonly boundaryId?: string | undefined;
      /**
       * Wall-clock ms (Date.now()) captured after startup work completes (forge refresh,
       * dynamic-mw recomposition, guard validation) — the same timestamp used for
       * `resetForRun()` on every iteration guard. Using one authoritative anchor for both
       * guard and governance enforcement prevents split-brain timeout decisions.
       *
       * Optional for backward compatibility: controllers fall back to `Date.now()`
       * when absent. Future values are clamped to now (non-finite values fall back
       * to now) so a buggy host cannot extend the duration window into the future.
       */
      readonly boundaryTimestamp?: number | undefined;
    }
  /**
   * Emitted by `runtime.cycleSession()` at a host-driven conversation boundary
   * (TUI `/clear`, `session:new`). Resets iteration counters AND rolling error-rate
   * windows so a fresh conversation doesn't inherit tool-error history. Token usage,
   * cost, and spawn counts remain CUMULATIVE across the runtime lifetime.
   *
   * `source`          — "host" (cycleSession() call), "engine" (internal restart)
   * `boundaryId`      — deterministic `${sessionId}:session:${sessionCycleIndex}`
   * `boundaryTimestamp` — wall-clock ms at the boundary; use for duration accounting
   */
  | {
      readonly kind: "session_reset";
      /**
       * Optional for backward compatibility: controllers default to `"host"` when absent.
       * Producers should always supply this to distinguish host-driven vs engine-driven resets.
       */
      readonly source?: "host" | "engine" | undefined;
      readonly reason?: string | undefined;
      /**
       * Optional for backward compatibility: controllers skip provenance logging when absent.
       */
      readonly boundaryId?: string | undefined;
      readonly boundaryTimestamp?: number | undefined;
    };

/**
 * Canonical boundary → governance event mapping.
 * This contract applies when `resetBudgetPerRun: true` is set on CreateKoiOptions.
 * When `resetBudgetPerRun: false` (default), no `run_reset` fires at run_start —
 * budgets accumulate across runs for the session lifetime.
 * Consumers: do not assume `run_reset` is always present. Use `session_reset` if
 * you only need to know when a new conversation starts.
 */
export const RESET_BOUNDARIES: {
  readonly turn_end: "no governance event — turn counters are per-run, not per-turn";
  readonly run_start: "run_reset (only when resetBudgetPerRun: true)";
  readonly session_cycle: "session_reset";
} = {
  turn_end: "no governance event — turn counters are per-run, not per-turn",
  run_start: "run_reset (only when resetBudgetPerRun: true)",
  session_cycle: "session_reset",
} as const;

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

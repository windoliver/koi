/**
 * Degradation state machine for Nexus-backed stores.
 *
 * Pure functions — no I/O, no side effects. Tracks consecutive failures
 * and transitions between "healthy" and "degraded" modes.
 */

import type { DegradationConfig } from "./config.js";
import { DEFAULT_DEGRADATION_CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DegradationMode = "healthy" | "degraded";

export interface DegradationState {
  readonly mode: DegradationMode;
  readonly failureCount: number;
  readonly lastSuccessAt: number;
  readonly degradedSince: number | undefined;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createDegradationState(): DegradationState {
  return {
    mode: "healthy",
    failureCount: 0,
    lastSuccessAt: Date.now(),
    degradedSince: undefined,
  };
}

// ---------------------------------------------------------------------------
// Transitions (pure — return new state, never mutate)
// ---------------------------------------------------------------------------

/**
 * Record a successful Nexus operation.
 * Resets failure count and transitions back to healthy if degraded.
 */
export function recordSuccess(_state: DegradationState): DegradationState {
  return {
    mode: "healthy",
    failureCount: 0,
    lastSuccessAt: Date.now(),
    degradedSince: undefined,
  };
}

/**
 * Record a failed Nexus operation.
 * Transitions to degraded mode if failure count exceeds threshold.
 */
export function recordFailure(
  state: DegradationState,
  config: DegradationConfig = DEFAULT_DEGRADATION_CONFIG,
): DegradationState {
  const newCount = state.failureCount + 1;
  if (newCount >= config.failureThreshold && state.mode === "healthy") {
    return {
      mode: "degraded",
      failureCount: newCount,
      lastSuccessAt: state.lastSuccessAt,
      degradedSince: Date.now(),
    };
  }
  return {
    ...state,
    failureCount: newCount,
  };
}

/**
 * Check if it's time to probe Nexus while in degraded mode.
 * Returns false when healthy (no probing needed).
 */
export function shouldProbe(
  state: DegradationState,
  config: DegradationConfig = DEFAULT_DEGRADATION_CONFIG,
  now: number = Date.now(),
): boolean {
  if (state.mode !== "degraded") return false;
  const elapsed = now - (state.degradedSince ?? state.lastSuccessAt);
  return elapsed >= config.probeIntervalMs;
}

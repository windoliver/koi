/**
 * Degradation state machine for the Nexus-backed SessionStore.
 *
 * Pure functions — no I/O, no side effects. Tracks consecutive failures
 * and transitions between "healthy" and "degraded".
 */

import type { DegradationConfig } from "./config.js";
import { DEFAULT_DEGRADATION_CONFIG } from "./config.js";

export type DegradationMode = "healthy" | "degraded";

export interface DegradationState {
  readonly mode: DegradationMode;
  readonly failureCount: number;
  readonly lastSuccessAt: number;
  readonly degradedSince: number | undefined;
  /** Wall-clock timestamp of the most recent failure recorded *while*
   *  already degraded. Used to rate-limit subsequent probes so a probe
   *  that itself fails still imposes the cooldown — without this, a
   *  persistently down Nexus would be probed on every cache miss. */
  readonly lastFailureAt: number | undefined;
}

export function createDegradationState(now: number = Date.now()): DegradationState {
  return {
    mode: "healthy",
    failureCount: 0,
    lastSuccessAt: now,
    degradedSince: undefined,
    lastFailureAt: undefined,
  };
}

/** Reset failure count and transition back to healthy. */
export function recordSuccess(
  _state: DegradationState,
  now: number = Date.now(),
): DegradationState {
  return {
    mode: "healthy",
    failureCount: 0,
    lastSuccessAt: now,
    degradedSince: undefined,
    lastFailureAt: undefined,
  };
}

/** Increment failure count; transition to degraded once threshold is reached.
 *  When already degraded, refresh `lastFailureAt` so shouldProbe rate-limits
 *  subsequent probes (so a failed probe doesn't open the floodgates). */
export function recordFailure(
  state: DegradationState,
  config: DegradationConfig = DEFAULT_DEGRADATION_CONFIG,
  now: number = Date.now(),
): DegradationState {
  const newCount = state.failureCount + 1;
  if (newCount >= config.failureThreshold && state.mode === "healthy") {
    return {
      mode: "degraded",
      failureCount: newCount,
      lastSuccessAt: state.lastSuccessAt,
      degradedSince: now,
      lastFailureAt: now,
    };
  }
  if (state.mode === "degraded") {
    return { ...state, failureCount: newCount, lastFailureAt: now };
  }
  return { ...state, failureCount: newCount };
}

/** True when degraded and the probe interval has elapsed since the most
 *  recent probe (whether it succeeded or failed). The cooldown is anchored
 *  on `lastFailureAt` (refreshed by every failed probe) so a persistently
 *  down Nexus is probed at the configured cadence, not on every miss. */
export function shouldProbe(
  state: DegradationState,
  config: DegradationConfig = DEFAULT_DEGRADATION_CONFIG,
  now: number = Date.now(),
): boolean {
  if (state.mode !== "degraded") return false;
  const anchor = state.lastFailureAt ?? state.degradedSince ?? state.lastSuccessAt;
  return now - anchor >= config.probeIntervalMs;
}

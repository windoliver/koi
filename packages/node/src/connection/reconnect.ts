/**
 * Exponential backoff with jitter for WebSocket reconnection.
 *
 * Computes delay using: min(base × multiplier^attempt, maxDelay) ± jitter.
 * Jitter reduces thundering-herd effects when many Nodes reconnect simultaneously.
 */

import type { GatewayConnectionConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Delay calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the reconnection delay for a given attempt number.
 *
 * @param attempt - Zero-based attempt counter.
 * @param config - Gateway connection settings (base, max, multiplier, jitter).
 * @returns Delay in milliseconds (always >= 0).
 */
export function computeReconnectDelay(attempt: number, config: GatewayConnectionConfig): number {
  const exponential = Math.min(
    config.reconnectBaseDelay * config.reconnectMultiplier ** attempt,
    config.reconnectMaxDelay,
  );
  const jitterRange = exponential * config.reconnectJitter;
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(exponential + jitterOffset));
}

// ---------------------------------------------------------------------------
// Reconnect state machine
// ---------------------------------------------------------------------------

export interface ReconnectState {
  readonly attempt: number;
  readonly exhausted: boolean;
}

const INITIAL_STATE: ReconnectState = { attempt: 0, exhausted: false };

/** Create a fresh reconnect tracker. */
export function createReconnectState(): ReconnectState {
  return INITIAL_STATE;
}

/** Advance to the next attempt. Returns new state (may be exhausted). */
export function nextAttempt(state: ReconnectState, maxRetries: number): ReconnectState {
  const nextCount = state.attempt + 1;
  if (maxRetries > 0 && nextCount >= maxRetries) {
    return { attempt: nextCount, exhausted: true };
  }
  return { attempt: nextCount, exhausted: false };
}

/** Reset state after a successful reconnection. */
export function resetReconnectState(): ReconnectState {
  return INITIAL_STATE;
}

// ---------------------------------------------------------------------------
// WS close code classification
// ---------------------------------------------------------------------------

/** Returns true if the close code indicates a clean shutdown (no retry). */
export function isCleanClose(code: number): boolean {
  return code === 1000 || code === 1001;
}

/** WS close code used when auth is permanently rejected (no retry). */
export const AUTH_FAILURE_CLOSE_CODE = 4001;

/** Returns true if the close code indicates an auth failure (no retry). */
export function isAuthFailure(code: number): boolean {
  return code === AUTH_FAILURE_CLOSE_CODE;
}

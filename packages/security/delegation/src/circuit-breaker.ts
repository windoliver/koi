/**
 * Per-delegatee circuit breaker state machine.
 *
 * States: closed → open → half_open → closed (success) / open (failure)
 *
 * When a delegatee accumulates too many failures, the circuit opens
 * and fast-fails delegation checks until the reset timeout expires.
 * After the timeout, the circuit enters half-open state and allows
 * a limited number of probes before deciding to close or re-open.
 */

import type { CircuitBreakerConfig } from "@koi/core";

export type CircuitState = "closed" | "open" | "half_open";

interface DelegateeState {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt: number;
  readonly halfOpenProbes: number;
}

export interface CircuitBreaker {
  readonly recordSuccess: (delegateeId: string) => void;
  readonly recordFailure: (delegateeId: string) => void;
  readonly canExecute: (delegateeId: string) => boolean;
  readonly getState: (delegateeId: string) => CircuitState;
}

const INITIAL_STATE: DelegateeState = Object.freeze({
  state: "closed" as const,
  failureCount: 0,
  lastFailureAt: 0,
  halfOpenProbes: 0,
});

/**
 * Creates a circuit breaker with per-delegatee state tracking.
 *
 * @param config - Circuit breaker thresholds
 * @param clock - Injectable clock for deterministic testing
 */
export function createCircuitBreaker(
  config: CircuitBreakerConfig,
  clock: () => number = Date.now,
): CircuitBreaker {
  const states = new Map<string, DelegateeState>();

  function getOrCreate(delegateeId: string): DelegateeState {
    return states.get(delegateeId) ?? INITIAL_STATE;
  }

  /** Resolve time-based state transitions (open → half_open after timeout). */
  function resolveState(entry: DelegateeState): DelegateeState {
    if (entry.state === "open") {
      const elapsed = clock() - entry.lastFailureAt;
      if (elapsed >= config.resetTimeoutMs) {
        return { ...entry, state: "half_open", halfOpenProbes: 0 };
      }
    }
    return entry;
  }

  function recordSuccess(delegateeId: string): void {
    const resolved = resolveState(getOrCreate(delegateeId));

    if (resolved.state === "half_open") {
      // Successful probe → close circuit (delete = return to INITIAL_STATE)
      states.delete(delegateeId);
    } else if (resolved.state === "closed") {
      // Reset failure count — if already zero, just remove entry
      if (resolved.failureCount === 0) {
        states.delete(delegateeId);
      } else {
        states.set(delegateeId, { ...resolved, failureCount: 0 });
      }
    }
  }

  function recordFailure(delegateeId: string): void {
    const resolved = resolveState(getOrCreate(delegateeId));

    if (resolved.state === "half_open") {
      // Failed probe → re-open circuit
      states.set(delegateeId, {
        ...resolved,
        state: "open",
        lastFailureAt: clock(),
      });
      return;
    }

    const newCount = resolved.failureCount + 1;
    const newState: CircuitState = newCount >= config.failureThreshold ? "open" : "closed";

    states.set(delegateeId, {
      ...resolved,
      failureCount: newCount,
      lastFailureAt: clock(),
      state: newState,
    });
  }

  function canExecute(delegateeId: string): boolean {
    const entry = states.get(delegateeId);
    if (entry === undefined) return true;

    const resolved = resolveState(entry);
    states.set(delegateeId, resolved);

    if (resolved.state === "open") return false;

    if (resolved.state === "half_open") {
      // Track probe and check against limit
      const probes = resolved.halfOpenProbes + 1;
      if (probes > config.halfOpenMaxProbes) {
        // Exceeded probe limit → re-open
        states.set(delegateeId, {
          ...resolved,
          state: "open",
          lastFailureAt: clock(),
        });
        return false;
      }
      states.set(delegateeId, { ...resolved, halfOpenProbes: probes });
    }

    return true;
  }

  function getState(delegateeId: string): CircuitState {
    const entry = states.get(delegateeId);
    if (entry === undefined) return "closed";
    const resolved = resolveState(entry);
    states.set(delegateeId, resolved);
    return resolved.state;
  }

  return { recordSuccess, recordFailure, canExecute, getState };
}

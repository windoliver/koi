/**
 * Circuit breaker state machine with fixed-size ring buffer.
 *
 * Tracks failure rates per provider and prevents traffic to unhealthy providers.
 * Uses encapsulated mutable state with immutable public snapshots.
 *
 * States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (probing) → CLOSED
 *
 * Note: assumes single-threaded runtime (Bun/Node). Synchronous state operations
 * are atomic between await points — no mutex needed.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly failureWindowMs: number;
  readonly failureStatusCodes: readonly number[];
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  failureWindowMs: 60_000,
  failureStatusCodes: [429, 500, 502, 503, 504],
} as const;

export interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt: number | undefined;
  readonly lastTransitionAt: number;
}

export interface CircuitBreaker {
  readonly isAllowed: () => boolean;
  readonly recordSuccess: () => CircuitBreakerSnapshot;
  readonly recordFailure: (statusCode?: number) => CircuitBreakerSnapshot;
  readonly getSnapshot: () => CircuitBreakerSnapshot;
  readonly reset: () => void;
}

/**
 * Creates a circuit breaker with encapsulated mutable state.
 *
 * @param config - Circuit breaker configuration
 * @param clock - Injectable clock for deterministic testing
 */
export function createCircuitBreaker(
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
  clock: () => number = Date.now,
): CircuitBreaker {
  // Mutable internal state (encapsulated, never exposed directly)
  let state: CircuitState = "CLOSED";
  let lastTransitionAt = clock();

  // Ring buffer for failure timestamps
  const ringBuffer: number[] = new Array(config.failureThreshold).fill(0);
  let ringIndex = 0;
  let ringCount = 0;

  /**
   * Single-pass scan over the ring buffer. Returns both the count of
   * recent failures (within window) and the most recent failure timestamp.
   */
  function scanRingBuffer(now: number): {
    readonly failureCount: number;
    readonly lastFailureAt: number | undefined;
  } {
    let count = 0;
    let lastFailureAt: number | undefined;
    const size = Math.min(ringCount, config.failureThreshold);
    for (let i = 0; i < size; i++) {
      const ts = ringBuffer[i];
      if (ts !== undefined && now - ts <= config.failureWindowMs) {
        count++;
        if (lastFailureAt === undefined || ts > lastFailureAt) {
          lastFailureAt = ts;
        }
      }
    }
    return { failureCount: count, lastFailureAt };
  }

  function snapshot(now?: number): CircuitBreakerSnapshot {
    const { failureCount, lastFailureAt } = scanRingBuffer(now ?? clock());
    return {
      state,
      failureCount,
      lastFailureAt,
      lastTransitionAt,
    };
  }

  function transitionTo(newState: CircuitState): void {
    state = newState;
    lastTransitionAt = clock();
  }

  function resetRingBuffer(): void {
    ringBuffer.fill(0);
    ringIndex = 0;
    ringCount = 0;
  }

  return {
    isAllowed(): boolean {
      const now = clock();
      switch (state) {
        case "CLOSED":
          return true;
        case "OPEN": {
          // Check if cooldown has passed → transition to HALF_OPEN
          if (now - lastTransitionAt >= config.cooldownMs) {
            transitionTo("HALF_OPEN");
            return true;
          }
          return false;
        }
        case "HALF_OPEN":
          // Allow one probe request
          return true;
        default: {
          const _exhaustive: never = state;
          throw new Error(`Unknown circuit state: ${String(_exhaustive)}`);
        }
      }
    },

    recordSuccess(): CircuitBreakerSnapshot {
      switch (state) {
        case "HALF_OPEN":
          // Probe succeeded → close circuit
          transitionTo("CLOSED");
          resetRingBuffer();
          break;
        case "CLOSED":
          // Normal operation — no state change needed
          break;
        case "OPEN":
          // Should not happen (isAllowed returns false), but treat as recovery
          break;
      }
      return snapshot();
    },

    recordFailure(statusCode?: number): CircuitBreakerSnapshot {
      // Only count configured status codes (or all if no status code provided)
      if (statusCode !== undefined && !config.failureStatusCodes.includes(statusCode)) {
        return snapshot();
      }

      const now = clock();

      switch (state) {
        case "CLOSED": {
          // Record failure in ring buffer
          ringBuffer[ringIndex % config.failureThreshold] = now;
          ringIndex++;
          ringCount++;

          // Check threshold with the same `now` — single scan, no redundant clock call
          const { failureCount } = scanRingBuffer(now);
          if (failureCount >= config.failureThreshold) {
            transitionTo("OPEN");
          }
          break;
        }
        case "HALF_OPEN":
          // Probe failed → back to OPEN
          transitionTo("OPEN");
          break;
        case "OPEN":
          // Already open — update failure tracking
          ringBuffer[ringIndex % config.failureThreshold] = now;
          ringIndex++;
          ringCount++;
          break;
      }

      return snapshot(now);
    },

    getSnapshot(): CircuitBreakerSnapshot {
      return snapshot();
    },

    reset(): void {
      transitionTo("CLOSED");
      resetRingBuffer();
    },
  };
}

/**
 * Health monitor with circuit breaker for Temporal server connectivity.
 *
 * Decision 8C: Health check + circuit breaker.
 * Polls the Temporal server health endpoint and trips the circuit
 * after consecutive failures, preventing cascading failures.
 *
 * Uses an inline circuit breaker to avoid runtime dependency on @koi/errors
 * dist (which may not be built in all environments). The circuit breaker
 * logic is identical to @koi/errors/circuit-breaker.ts.
 */

// ---------------------------------------------------------------------------
// Inline circuit breaker (mirrors @koi/errors/circuit-breaker.ts)
// ---------------------------------------------------------------------------

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt: number | undefined;
  readonly lastTransitionAt: number;
}

interface CircuitBreaker {
  readonly isAllowed: () => boolean;
  readonly recordSuccess: () => CircuitBreakerSnapshot;
  readonly recordFailure: () => CircuitBreakerSnapshot;
  readonly getSnapshot: () => CircuitBreakerSnapshot;
  readonly reset: () => void;
}

function createCircuitBreaker(
  failureThreshold: number,
  cooldownMs: number,
  clock: () => number,
): CircuitBreaker {
  let state: CircuitState = "CLOSED";
  let lastTransitionAt = clock();
  let failureCount = 0;
  let lastFailureAt: number | undefined;

  function snapshot(): CircuitBreakerSnapshot {
    return { state, failureCount, lastFailureAt, lastTransitionAt };
  }

  function transitionTo(newState: CircuitState): void {
    state = newState;
    lastTransitionAt = clock();
  }

  return {
    isAllowed(): boolean {
      switch (state) {
        case "CLOSED":
          return true;
        case "OPEN": {
          if (clock() - lastTransitionAt >= cooldownMs) {
            transitionTo("HALF_OPEN");
            return true;
          }
          return false;
        }
        case "HALF_OPEN":
          return true;
      }
    },

    recordSuccess(): CircuitBreakerSnapshot {
      if (state === "HALF_OPEN") {
        transitionTo("CLOSED");
        failureCount = 0;
        lastFailureAt = undefined;
      }
      return snapshot();
    },

    recordFailure(): CircuitBreakerSnapshot {
      failureCount++;
      lastFailureAt = clock();

      switch (state) {
        case "CLOSED":
          if (failureCount >= failureThreshold) {
            transitionTo("OPEN");
          }
          break;
        case "HALF_OPEN":
          transitionTo("OPEN");
          break;
        case "OPEN":
          break;
      }
      return snapshot();
    },

    getSnapshot: snapshot,

    reset(): void {
      transitionTo("CLOSED");
      failureCount = 0;
      lastFailureAt = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

export type TemporalHealthStatus = "healthy" | "degraded" | "unavailable";

export interface TemporalHealthSnapshot {
  readonly status: TemporalHealthStatus;
  readonly circuitState: CircuitState;
  readonly lastCheckAt: number;
  readonly consecutiveFailures: number;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TemporalHealthConfig {
  /** Temporal server gRPC/HTTP URL. */
  readonly url: string;
  /** Poll interval in ms. Default: 10_000. */
  readonly pollIntervalMs: number;
  /** Consecutive failures before circuit trips. Default: 3. */
  readonly failureThreshold: number;
  /** Cooldown before retry after circuit trips (ms). Default: 60_000. */
  readonly cooldownMs: number;
  /** Health check timeout per request (ms). Default: 5_000. */
  readonly timeoutMs: number;
  /** Injectable clock for testing. */
  readonly clock?: (() => number) | undefined;
}

export const DEFAULT_TEMPORAL_HEALTH_CONFIG: Omit<TemporalHealthConfig, "url"> = Object.freeze({
  pollIntervalMs: 10_000,
  failureThreshold: 3,
  cooldownMs: 60_000,
  timeoutMs: 5_000,
});

// ---------------------------------------------------------------------------
// Health monitor
// ---------------------------------------------------------------------------

export interface TemporalHealthMonitor {
  /** Get current health snapshot. */
  readonly snapshot: () => TemporalHealthSnapshot;
  /** Check if the circuit breaker allows requests. */
  readonly isAvailable: () => boolean;
  /** Register a listener for health status changes. */
  readonly onStatusChange: (listener: (snapshot: TemporalHealthSnapshot) => void) => () => void;
  /** Start polling. */
  readonly start: () => void;
  /** Stop polling and clean up. */
  readonly dispose: () => void;
}

/**
 * Create a health monitor for Temporal server connectivity.
 *
 * @param config - Health monitor configuration
 * @param healthCheckFn - Injectable health check function for testing.
 */
export function createTemporalHealthMonitor(
  config: TemporalHealthConfig,
  healthCheckFn?: (url: string, timeoutMs: number) => Promise<boolean>,
): TemporalHealthMonitor {
  const clock = config.clock ?? Date.now;
  const checkHealth = healthCheckFn ?? defaultHealthCheck;

  const circuit: CircuitBreaker = createCircuitBreaker(
    config.failureThreshold,
    config.cooldownMs,
    clock,
  );

  let consecutiveFailures = 0;
  let lastCheckAt = 0;
  let lastStatus: TemporalHealthStatus = "healthy";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const listeners: Set<(snapshot: TemporalHealthSnapshot) => void> = new Set();

  function computeStatus(): TemporalHealthStatus {
    const snap = circuit.getSnapshot();
    switch (snap.state) {
      case "CLOSED":
        return "healthy";
      case "HALF_OPEN":
        return "degraded";
      case "OPEN":
        return "unavailable";
    }
  }

  function buildSnapshot(): TemporalHealthSnapshot {
    return {
      status: computeStatus(),
      circuitState: circuit.getSnapshot().state,
      lastCheckAt,
      consecutiveFailures,
      url: config.url,
    };
  }

  function notifyIfChanged(): void {
    const current = computeStatus();
    if (current !== lastStatus) {
      lastStatus = current;
      const snap = buildSnapshot();
      for (const listener of listeners) {
        listener(snap);
      }
    }
  }

  async function poll(): Promise<void> {
    lastCheckAt = clock();
    try {
      const ok = await checkHealth(config.url, config.timeoutMs);
      if (ok) {
        consecutiveFailures = 0;
        circuit.recordSuccess();
      } else {
        consecutiveFailures++;
        circuit.recordFailure();
      }
    } catch {
      consecutiveFailures++;
      circuit.recordFailure();
    }
    notifyIfChanged();
  }

  return {
    snapshot: buildSnapshot,

    isAvailable(): boolean {
      return circuit.isAllowed();
    },

    onStatusChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start(): void {
      if (pollTimer !== undefined) return;
      void poll();
      pollTimer = setInterval(() => void poll(), config.pollIntervalMs);
    },

    dispose(): void {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Default health check
// ---------------------------------------------------------------------------

/** Temporal UI/HTTP port is typically gRPC port + 1000 (7233 → 8233). */
const TEMPORAL_HTTP_HEALTH_PORT = 7243;

async function defaultHealthCheck(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const httpUrl = url.replace(/:\d+$/, `:${TEMPORAL_HTTP_HEALTH_PORT}`);
    const response = await fetch(`${httpUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

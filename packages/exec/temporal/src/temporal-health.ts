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
      failureCount = 0;
      lastFailureAt = undefined;
      if (state === "HALF_OPEN") {
        transitionTo("CLOSED");
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
  };
}

export type TemporalHealthStatus = "healthy" | "degraded" | "unavailable";

export interface TemporalHealthSnapshot {
  readonly status: TemporalHealthStatus;
  readonly circuitState: CircuitState;
  readonly lastCheckAt: number;
  readonly consecutiveFailures: number;
  readonly url: string;
}

export interface TemporalHealthConfig {
  readonly url: string;
  readonly pollIntervalMs: number;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly timeoutMs: number;
  readonly clock?: (() => number) | undefined;
}

export const DEFAULT_TEMPORAL_HEALTH_CONFIG: Omit<TemporalHealthConfig, "url"> = Object.freeze({
  pollIntervalMs: 10_000,
  failureThreshold: 3,
  cooldownMs: 60_000,
  timeoutMs: 5_000,
});

export interface TemporalHealthMonitor {
  readonly snapshot: () => TemporalHealthSnapshot;
  readonly isAvailable: () => boolean;
  readonly onStatusChange: (listener: (snapshot: TemporalHealthSnapshot) => void) => () => void;
  readonly start: () => void;
  readonly dispose: () => void;
}

export function createTemporalHealthMonitor(
  config: TemporalHealthConfig,
  healthCheckFn?: (url: string, timeoutMs: number) => Promise<boolean>,
): TemporalHealthMonitor {
  const clock = config.clock ?? Date.now;
  const checkHealth = healthCheckFn ?? defaultHealthCheck;

  const circuit = createCircuitBreaker(config.failureThreshold, config.cooldownMs, clock);

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

const TEMPORAL_HTTP_PORT_OFFSET = 1000;

async function defaultHealthCheck(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const portMatch = url.match(/:(\d+)$/);
    const grpcPort = portMatch !== null ? Number.parseInt(portMatch[1] ?? "7233", 10) : 7233;
    const httpPort = grpcPort + TEMPORAL_HTTP_PORT_OFFSET;
    const host = url.replace(/:\d+$/, "");
    const response = await fetch(`http://${host}:${httpPort}/api/v1/namespaces`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

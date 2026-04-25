type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt: number | undefined;
  readonly lastTransitionAt: number;
}

interface CircuitBreaker {
  readonly isAllowed: () => boolean;
  readonly allowProbe: () => void;
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
    // Pure read — never mutates state. HALF_OPEN means the probe is in flight;
    // traffic stays gated until a successful probe closes the circuit.
    isAllowed(): boolean {
      return state === "CLOSED";
    },

    // Called by the poll path before each health check. Transitions OPEN → HALF_OPEN
    // once cooldown has elapsed, allowing one probe through without resuming traffic.
    allowProbe(): void {
      if (state === "OPEN" && clock() - lastTransitionAt >= cooldownMs) {
        transitionTo("HALF_OPEN");
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
  // Explicit HTTP health endpoint. When provided, defaultHealthCheck uses this URL
  // directly instead of deriving one from the gRPC port (grpcPort + 1000 convention).
  // Required for Temporal Cloud, TLS, reverse-proxied, or non-standard deployments.
  readonly healthUrl?: string | undefined;
  readonly pollIntervalMs: number;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly timeoutMs: number;
  readonly clock?: (() => number) | undefined;
  /**
   * When true, HTTP 401/403 responses count as "reachable" — useful for auth-protected
   * Temporal frontends where the health endpoint requires credentials. Defaults to false
   * so misconfigured proxies or wrong endpoints do not produce false-positive readiness.
   */
  readonly allowAuthErrors?: boolean | undefined;
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
  const checkHealth =
    healthCheckFn ??
    ((url: string, timeoutMs: number) =>
      defaultHealthCheck(url, timeoutMs, config.allowAuthErrors ?? false));

  const circuit = createCircuitBreaker(config.failureThreshold, config.cooldownMs, clock);

  let consecutiveFailures = 0;
  let lastCheckAt = 0;
  // Fail closed: isAvailable() returns false until the first probe completes,
  // preventing traffic to Temporal before connectivity is confirmed.
  let firstProbeCompleted = false;
  let lastStatus: TemporalHealthStatus = "degraded";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;
  const listeners: Set<(snapshot: TemporalHealthSnapshot) => void> = new Set();

  function computeStatus(): TemporalHealthStatus {
    if (!firstProbeCompleted) return "degraded";
    const snap = circuit.getSnapshot();
    switch (snap.state) {
      case "CLOSED":
        // Any consecutive failure means the last probe failed — degrade immediately
        // rather than waiting for the circuit to open. This makes partial outages
        // visible to callers before the threshold is reached.
        return snap.failureCount > 0 ? "degraded" : "healthy";
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
    // Single-flight guard: if the previous check is still in flight (e.g. slow or timing out),
    // skip this interval rather than running concurrent mutations on circuit-breaker state.
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      lastCheckAt = clock();
      circuit.allowProbe(); // OPEN → HALF_OPEN if cooldown elapsed (before, not after, the probe)
      try {
        const ok = await checkHealth(config.healthUrl ?? config.url, config.timeoutMs);
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
      firstProbeCompleted = true;
      notifyIfChanged();
    } finally {
      pollInFlight = false;
    }
  }

  return {
    snapshot: buildSnapshot,

    isAvailable(): boolean {
      return firstProbeCompleted && circuit.isAllowed();
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

async function defaultHealthCheck(
  url: string,
  timeoutMs: number,
  allowAuthErrors: boolean,
): Promise<boolean> {
  try {
    // If a full HTTP(S) URL is provided (via healthUrl), use it directly to support
    // Temporal Cloud, TLS, and reverse-proxied setups where grpcPort + 1000 is wrong.
    const endpoint =
      url.startsWith("http://") || url.startsWith("https://")
        ? url
        : (() => {
            const portMatch = url.match(/:(\d+)$/);
            const grpcPort =
              portMatch !== null ? Number.parseInt(portMatch[1] ?? "7233", 10) : 7233;
            const httpPort = grpcPort + TEMPORAL_HTTP_PORT_OFFSET;
            const host = url.replace(/:\d+$/, "");
            return `http://${host}:${httpPort}/api/v1/namespaces`;
          })();
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 2xx = healthy. 401/403 = healthy only when allowAuthErrors opt-in is set
    // (auth-protected Temporal frontends that require credentials on the health endpoint).
    // 3xx, 404, other 4xx, and 5xx all indicate wrong endpoint or server failure.
    return response.ok || (allowAuthErrors && (response.status === 401 || response.status === 403));
  } catch {
    return false;
  }
}

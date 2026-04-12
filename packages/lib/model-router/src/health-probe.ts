/**
 * Active health probing for local LLM providers.
 *
 * Periodically pings local providers (localhost / 127.0.0.1) to detect
 * recovery after a circuit breaker opens. Remote providers are monitored
 * passively via circuit breaker state from real request outcomes.
 *
 * Design decisions:
 * - Local-only: probing remote cloud APIs burns rate limits and costs money.
 * - Bun.unref(): timer does not block process/test exit if dispose() is forgotten.
 * - Injectable setInterval: enables deterministic timer tests.
 */

import type { CircuitBreaker } from "@koi/errors";
import type { ProviderAdapter } from "./provider-adapter.js";

export interface ProbeTarget {
  readonly id: string;
  readonly adapter: ProviderAdapter;
  readonly circuitBreaker: CircuitBreaker;
  /** Base URL for the adapter — used to determine if this is a local target. */
  readonly baseUrl?: string | undefined;
}

export interface HealthProbe {
  /** Stops the health probe timer. Safe to call multiple times. */
  readonly dispose: () => void;
  /** Runs a probe cycle immediately (for testing). */
  readonly runOnce: () => Promise<void>;
}

/** Returns true if the URL is a local / loopback address. */
function isLocalUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("[::1]");
}

export interface CreateHealthProbeOptions {
  readonly targets: readonly ProbeTarget[];
  readonly intervalMs: number;
  /**
   * Injectable setInterval for deterministic testing.
   * Defaults to global setInterval. The return value must be unref-able
   * (a Bun/Node timer handle).
   */
  readonly setInterval?: typeof globalThis.setInterval | undefined;
}

/**
 * Creates an active health probe that pings local providers on a timer.
 *
 * Returns undefined if no targets have local URLs with checkHealth adapters.
 */
export function createHealthProbe(options: CreateHealthProbeOptions): HealthProbe | undefined {
  const localTargets = options.targets.filter(
    (t) => t.adapter.checkHealth !== undefined && isLocalUrl(t.baseUrl),
  );

  if (localTargets.length === 0) return undefined;

  const setIntervalFn = options.setInterval ?? globalThis.setInterval;

  async function runOnce(): Promise<void> {
    await Promise.allSettled(
      localTargets.map(async (t) => {
        try {
          const checkHealth = t.adapter.checkHealth;
          const healthy = checkHealth !== undefined && (await checkHealth());
          if (healthy) {
            t.circuitBreaker.recordSuccess();
          } else {
            t.circuitBreaker.recordFailure();
          }
        } catch {
          t.circuitBreaker.recordFailure();
        }
      }),
    );
  }

  // Run immediately on start
  void runOnce();

  const timer = setIntervalFn(runOnce, options.intervalMs);

  // Prevent the timer from blocking process/test exit if dispose() is forgotten.
  // Bun exposes .unref() on timers (Node-compatible).
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  let disposed = false;

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
    runOnce,
  };
}

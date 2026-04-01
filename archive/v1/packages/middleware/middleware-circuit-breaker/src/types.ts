/**
 * Configuration types for circuit breaker middleware.
 */

import type { CircuitBreakerConfig } from "@koi/errors";

export interface CircuitBreakerMiddlewareConfig {
  /** Circuit breaker FSM config (threshold, cooldown, window, status codes). */
  readonly breaker?: Partial<CircuitBreakerConfig>;
  /**
   * Maximum number of provider breaker entries before logging a warning.
   * Protects against accidental unbounded growth from incorrect key extraction.
   * Default: 50.
   */
  readonly maxProviderEntries?: number;
}

export interface ResolvedCircuitBreakerMiddlewareConfig {
  readonly breaker: CircuitBreakerConfig;
  readonly maxProviderEntries: number;
}

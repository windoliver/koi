/**
 * Configuration types for circuit breaker middleware.
 */

import type { CircuitBreakerConfig } from "@koi/errors";

export interface CircuitBreakerMiddlewareConfig {
  /** Circuit breaker FSM config (threshold, cooldown, window, status codes). */
  readonly breaker?: Partial<CircuitBreakerConfig>;
  /**
   * Fallback model to use when the primary provider's circuit is open.
   * Format: "provider:model-name" (e.g., "openai:gpt-4o").
   * If undefined, requests fail fast with RATE_LIMIT error when circuit is open.
   */
  readonly fallbackModel?: string;
  /**
   * Maximum number of provider breaker entries before logging a warning.
   * Protects against accidental unbounded growth from incorrect key extraction.
   * Default: 50.
   */
  readonly maxProviderEntries?: number;
}

export interface ResolvedCircuitBreakerMiddlewareConfig {
  readonly breaker: CircuitBreakerConfig;
  readonly fallbackModel: string | undefined;
  readonly maxProviderEntries: number;
}

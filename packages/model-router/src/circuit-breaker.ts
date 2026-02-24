/**
 * Re-exports circuit breaker from @koi/errors (L0u).
 *
 * Circuit breaker was extracted to @koi/errors so that other L2 packages
 * (e.g., @koi/webhook-delivery) can use it without depending on @koi/model-router.
 */

export {
  type CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
  type CircuitState,
  createCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "@koi/errors";

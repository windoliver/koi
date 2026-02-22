/**
 * @koi/model-router — Multi-provider LLM routing with failover (Layer 2)
 *
 * World Service that routes model calls across multiple LLM providers
 * with retry, fallback chains, and circuit breaker resilience.
 *
 * Depends on @koi/core (for types) and @koi/validation (for config validation).
 */

// Resilience
export {
  type CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
  type CircuitState,
  createCircuitBreaker,
} from "./circuit-breaker.js";
// Config
export type {
  ModelRouterConfig,
  ModelTargetConfig,
  ResolvedRouterConfig,
  RoutingStrategy,
} from "./config.js";
export {
  type FallbackAttempt,
  type FallbackResult,
  type FallbackTarget,
  withFallback,
} from "./fallback.js";
// Middleware
export { createModelRouterMiddleware } from "./middleware.js";

// Provider
export type { ProviderAdapter, ProviderAdapterConfig, StreamChunk } from "./provider-adapter.js";
export { calculateBackoff, type RetryConfig, withRetry } from "./retry.js";
// Router
export { createModelRouter, type ModelRouter, type RouterMetrics } from "./router.js";

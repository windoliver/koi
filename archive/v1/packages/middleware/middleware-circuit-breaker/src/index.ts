/**
 * @koi/middleware-circuit-breaker — Per-provider circuit breaker with optional model fallback.
 *
 * Prevents traffic to unhealthy LLM providers. Reuses the battle-tested
 * CircuitBreaker FSM from @koi/errors with per-provider state isolation.
 */

export { createCircuitBreakerMiddleware } from "./circuit-breaker-middleware.js";
export type {
  CircuitBreakerMiddlewareConfig,
  ResolvedCircuitBreakerMiddlewareConfig,
} from "./types.js";

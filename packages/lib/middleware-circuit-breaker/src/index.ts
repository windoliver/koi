/**
 * @koi/middleware-circuit-breaker — Per-provider circuit breaker for model calls.
 *
 * Trips on repeated failures, fails fast during cooldown, allows a single probe
 * in HALF_OPEN to detect recovery. Wraps the `createCircuitBreaker` primitive
 * from `@koi/errors`.
 */

export { createCircuitBreakerMiddleware } from "./circuit-breaker-middleware.js";
export type { CircuitBreakerMiddlewareConfig } from "./types.js";

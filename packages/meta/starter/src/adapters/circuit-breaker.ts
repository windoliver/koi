/**
 * Manifest adapter for @koi/middleware-circuit-breaker.
 *
 * Reads manifest.middleware[].options and instantiates createCircuitBreakerMiddleware.
 * All options are JSON-serializable.
 */

import type { KoiMiddleware, MiddlewareConfig } from "@koi/core";
import {
  type CircuitBreakerMiddlewareConfig,
  createCircuitBreakerMiddleware,
} from "@koi/middleware-circuit-breaker";

export function createCircuitBreakerAdapter(config: MiddlewareConfig): KoiMiddleware {
  const options = (config.options ?? {}) as Partial<CircuitBreakerMiddlewareConfig>;
  return createCircuitBreakerMiddleware(options);
}

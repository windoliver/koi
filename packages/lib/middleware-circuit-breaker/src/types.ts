/**
 * Circuit breaker middleware configuration.
 */

import type { CircuitBreakerConfig } from "@koi/errors";

export interface CircuitBreakerMiddlewareConfig {
  /** Override defaults from `@koi/errors` (failureThreshold, cooldownMs, etc.). */
  readonly breaker?: Partial<CircuitBreakerConfig>;
  /** Map a model string to a circuit key. Default: prefix before "/" or "default". */
  readonly extractKey?: (model: string | undefined) => string;
  /** Soft bound on per-key Map size; logs once if exceeded. Default 50. */
  readonly maxKeys?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  readonly clock?: () => number;
}

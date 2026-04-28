/**
 * Circuit breaker middleware configuration.
 */

import type { TurnContext } from "@koi/core";
import type { CircuitBreakerConfig } from "@koi/errors";

export interface CircuitBreakerMiddlewareConfig {
  /** Override defaults from `@koi/errors` (failureThreshold, cooldownMs, etc.). */
  readonly breaker?: Partial<CircuitBreakerConfig>;
  /**
   * Map a request to a circuit key. Receives the model string and the
   * current `TurnContext` so multi-tenant deployments can scope circuits
   * by tenant/account/credential, preventing one tenant's quota
   * exhaustion from tripping the breaker for unrelated traffic.
   *
   * Default: provider prefix before "/" (or `"default"`). This is
   * appropriate only for single-tenant deployments — see middleware
   * docs for the multi-tenant pattern.
   */
  readonly extractKey?: (model: string | undefined, ctx: TurnContext) => string;
  /** Soft bound on per-key Map size; logs once if exceeded. Default 50. */
  readonly maxKeys?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  readonly clock?: () => number;
}

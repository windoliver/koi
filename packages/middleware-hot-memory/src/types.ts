/**
 * Configuration types for the middleware-hot-memory package.
 */

import type { TokenEstimator } from "@koi/core/context";
import type { MemoryComponent } from "@koi/core/ecs";

/** User-facing configuration for createHotMemoryMiddleware. */
export interface HotMemoryConfig {
  /** Memory component to recall hot-tier memories from. */
  readonly memory: MemoryComponent;
  /** Max tokens for the injected hot memory block. Default: 4000. */
  readonly maxTokens?: number | undefined;
  /** Turns between refreshes. Default: 5. 0 = session start only. */
  readonly refreshInterval?: number | undefined;
  /** Override the default token estimator. */
  readonly tokenEstimator?: TokenEstimator | undefined;
}

export interface HotMemoryDefaults {
  readonly maxTokens: number;
  readonly refreshInterval: number;
}

export const HOT_MEMORY_DEFAULTS: HotMemoryDefaults = Object.freeze({
  maxTokens: 4_000,
  refreshInterval: 5,
});

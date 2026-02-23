/**
 * Factory for creating a TieredSandboxExecutor — trust-tier-aware dispatcher.
 *
 * Accepts per-tier backends, pre-computes resolution at construction,
 * and routes forTier() calls via an immutable lookup map.
 */

import type { KoiError, Result, TieredSandboxExecutor, TierResolution, TrustTier } from "@koi/core";
import { createPromotedExecutor } from "./promoted-executor.js";
import type { TieredExecutorConfig } from "./resolve.js";
import { resolveTiers } from "./resolve.js";

// ---------------------------------------------------------------------------
// Internal: build executor from pre-computed resolution map
// ---------------------------------------------------------------------------

export function buildExecutorFromMap(
  resolutionMap: ReadonlyMap<TrustTier, TierResolution>,
): Result<TieredSandboxExecutor, KoiError> {
  if (resolutionMap.size === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TieredSandboxExecutor: no tiers could be resolved — config is empty",
        retryable: false,
      },
    };
  }

  const executor: TieredSandboxExecutor = {
    forTier: (tier: TrustTier) => {
      const resolution = resolutionMap.get(tier);
      if (resolution === undefined) {
        throw new Error(
          `TieredSandboxExecutor: no executor available for tier "${tier}". ` +
            `Configure a "${tier}" backend or a lower-trust fallback.`,
        );
      }
      return resolution;
    },
  };

  return { ok: true, value: executor };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createTieredExecutor(
  config: TieredExecutorConfig,
): Result<TieredSandboxExecutor, KoiError> {
  // Ensure promoted tier always has a backend (built-in default)
  const effectiveConfig: TieredExecutorConfig = {
    ...config,
    promoted: config.promoted ?? createPromotedExecutor(),
  };

  const resolutionMap = resolveTiers(effectiveConfig);
  return buildExecutorFromMap(resolutionMap);
}

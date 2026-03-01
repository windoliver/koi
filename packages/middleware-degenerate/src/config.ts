/**
 * Configuration validation for the degenerate middleware.
 */

import type { KoiError, Result } from "@koi/core";
import { validation } from "@koi/core";
import type { DegenerateMiddlewareConfig } from "./types.js";

export function validateDegenerateConfig(
  config: DegenerateMiddlewareConfig,
): Result<DegenerateMiddlewareConfig, KoiError> {
  if (config.capabilityConfigs.size === 0) {
    return {
      ok: false,
      error: validation("DegenerateMiddleware config requires at least one capability config"),
    };
  }

  for (const [name, cfg] of config.capabilityConfigs) {
    if (cfg.minVariants > cfg.maxVariants) {
      return {
        ok: false,
        error: validation(
          `Capability "${name}": minVariants (${String(cfg.minVariants)}) must be <= maxVariants (${String(cfg.maxVariants)})`,
        ),
      };
    }
  }

  return { ok: true, value: config };
}

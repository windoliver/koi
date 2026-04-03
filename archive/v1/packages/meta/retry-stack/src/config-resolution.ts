/**
 * 3-layer config resolution: defaults → preset → user overrides.
 */

import type { SemanticRetryConfig } from "@koi/middleware-semantic-retry";
import { lookupPreset } from "@koi/preset-resolver";
import { RETRY_STACK_PRESET_SPECS } from "./presets.js";
import type { ResolvedRetryStackConfig, RetryStackConfig } from "./types.js";

/** Resolves retry-stack config by merging defaults → preset → user overrides. */
export function resolveRetryStackConfig(config: RetryStackConfig): ResolvedRetryStackConfig {
  const { preset, spec } = lookupPreset(RETRY_STACK_PRESET_SPECS, config.preset, "standard");

  // Merge semantic-retry: preset defaults + user overrides
  const semanticRetry: SemanticRetryConfig = {
    ...spec.semanticRetry,
    ...config.semanticRetry,
  };

  // Guided-retry: user override ?? preset default ?? undefined
  const guidedRetry = config.guidedRetry ?? spec.guidedRetry;

  // Fs-rollback: user must provide full config (requires I/O backends)
  const fsRollback = config.fsRollback;

  return {
    preset,
    semanticRetry,
    guidedRetry,
    fsRollback,
  };
}

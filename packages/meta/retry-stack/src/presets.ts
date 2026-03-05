/**
 * Frozen preset specifications for retry-stack bundles.
 *
 * "light"      — minimal: semantic-retry only, low retries, no fs-rollback.
 * "standard"   — balanced: semantic + guided, moderate retries. fs-rollback if user provides config.
 * "aggressive" — maximum: semantic + guided, high retries. fs-rollback if user provides config.
 */

import type { RetryStackPreset, RetryStackPresetSpec } from "./types.js";

const LIGHT: RetryStackPresetSpec = Object.freeze({
  semanticRetry: Object.freeze({ maxRetries: 1 }),
});

const STANDARD: RetryStackPresetSpec = Object.freeze({
  semanticRetry: Object.freeze({ maxRetries: 3 }),
  guidedRetry: Object.freeze({}),
  fsRollbackExpected: true,
});

const AGGRESSIVE: RetryStackPresetSpec = Object.freeze({
  semanticRetry: Object.freeze({ maxRetries: 5 }),
  guidedRetry: Object.freeze({}),
  fsRollbackExpected: true,
});

/** Frozen registry of retry-stack preset specifications. */
export const RETRY_STACK_PRESET_SPECS: Readonly<Record<RetryStackPreset, RetryStackPresetSpec>> =
  Object.freeze({
    light: LIGHT,
    standard: STANDARD,
    aggressive: AGGRESSIVE,
  });

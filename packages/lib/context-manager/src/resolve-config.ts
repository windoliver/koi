/**
 * Config resolution and validation.
 *
 * Applies defaults to partial config, validates cross-field constraints.
 * Returns Result<ResolvedConfig, string[]> — errors are strings, not thrown.
 */

import { FALLBACK_ESTIMATOR } from "./fallback-estimator.js";
import { resolveThresholds } from "./resolve-thresholds.js";
import type { CompactionManagerConfig, ResolvedConfig } from "./types.js";
import { COMPACTION_DEFAULTS } from "./types.js";

/** Validation result: either a resolved config or a list of error messages. */
export type ConfigResult =
  | { readonly ok: true; readonly value: ResolvedConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate a fraction value is in [0, 1].
 */
function validateFraction(name: string, value: number, errors: string[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${name} must be between 0 and 1, got ${value}`);
  }
}

/**
 * Validate a positive integer.
 */
function validatePositive(name: string, value: number, errors: string[]): void {
  if (!Number.isFinite(value) || value <= 0) {
    errors.push(`${name} must be positive, got ${value}`);
  }
}

/**
 * Validate a non-negative integer.
 */
function validateNonNegative(name: string, value: number, errors: string[]): void {
  if (!Number.isFinite(value) || value < 0) {
    errors.push(`${name} must be non-negative, got ${value}`);
  }
}

/**
 * Validate a non-negative integer.
 */
function validateNonNegativeInteger(name: string, value: number, errors: string[]): void {
  validateNonNegative(name, value, errors);
  if (!Number.isInteger(value)) {
    errors.push(`${name} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Resolve a partial config into a fully-resolved config with all defaults applied.
 * Validates all constraints and returns errors if any field is invalid.
 *
 * Constraints checked:
 * - contextWindowSize > 0
 * - preserveRecent >= 0
 * - micro.triggerFraction in [0, 1]
 * - micro.targetFraction in [0, 1]
 * - micro.targetFraction < micro.triggerFraction
 * - full.triggerFraction in [0, 1]
 * - micro.triggerFraction <= full.triggerFraction
 * - full.maxSummaryTokens >= 0
 * - backoff.initialSkip > 0
 * - backoff.cap >= initialSkip
 * - replacement.maxResultTokens > 0
 * - replacement.maxMessageTokens >= maxResultTokens
 * - replacement.previewChars > 0
 */
export function resolveConfig(partial?: CompactionManagerConfig): ConfigResult {
  const resolvedPolicy = resolveThresholds(partial);
  const resolved: ResolvedConfig = {
    contextWindowSize: resolvedPolicy.contextWindow,
    preserveRecent: partial?.preserveRecent ?? COMPACTION_DEFAULTS.preserveRecent,
    prunePreserveLastK: resolvedPolicy.prunePreserveLastK,
    tokenEstimator: partial?.tokenEstimator ?? FALLBACK_ESTIMATOR,
    micro: {
      triggerFraction: resolvedPolicy.softTriggerFraction,
      targetFraction: partial?.micro?.targetFraction ?? COMPACTION_DEFAULTS.micro.targetFraction,
      strategy: partial?.micro?.strategy ?? COMPACTION_DEFAULTS.micro.strategy,
    },
    full: {
      triggerFraction: resolvedPolicy.hardTriggerFraction,
      maxSummaryTokens:
        partial?.full?.maxSummaryTokens ?? COMPACTION_DEFAULTS.full.maxSummaryTokens,
    },
    backoff: {
      initialSkip: partial?.backoff?.initialSkip ?? COMPACTION_DEFAULTS.backoff.initialSkip,
      cap: partial?.backoff?.cap ?? COMPACTION_DEFAULTS.backoff.cap,
    },
    replacement: {
      maxResultTokens:
        partial?.replacement?.maxResultTokens ?? COMPACTION_DEFAULTS.replacement.maxResultTokens,
      maxMessageTokens:
        partial?.replacement?.maxMessageTokens ?? COMPACTION_DEFAULTS.replacement.maxMessageTokens,
      previewChars:
        partial?.replacement?.previewChars ?? COMPACTION_DEFAULTS.replacement.previewChars,
    },
  };

  const errors = [...validateResolvedConfig(resolved)];
  validateNonNegativeInteger("prunePreserveLastK", resolvedPolicy.prunePreserveLastK, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: resolved };
}

/**
 * Validate a fully-resolved config. Returns an array of error messages
 * (empty = valid).
 */
export function validateResolvedConfig(config: ResolvedConfig): readonly string[] {
  const errors: string[] = [];

  // Top-level
  validatePositive("contextWindowSize", config.contextWindowSize, errors);
  validateNonNegative("preserveRecent", config.preserveRecent, errors);
  validateNonNegativeInteger("prunePreserveLastK", config.prunePreserveLastK, errors);

  // Micro
  validateFraction("micro.triggerFraction", config.micro.triggerFraction, errors);
  validateFraction("micro.targetFraction", config.micro.targetFraction, errors);
  if (config.micro.targetFraction >= config.micro.triggerFraction) {
    errors.push(
      `micro.targetFraction (${config.micro.targetFraction}) must be less than micro.triggerFraction (${config.micro.triggerFraction})`,
    );
  }

  // Full
  validateFraction("full.triggerFraction", config.full.triggerFraction, errors);
  if (config.micro.triggerFraction > config.full.triggerFraction) {
    errors.push(
      `micro.triggerFraction (${config.micro.triggerFraction}) must not exceed full.triggerFraction (${config.full.triggerFraction})`,
    );
  }
  validateNonNegative("full.maxSummaryTokens", config.full.maxSummaryTokens, errors);

  // Backoff
  validatePositive("backoff.initialSkip", config.backoff.initialSkip, errors);
  if (config.backoff.cap < config.backoff.initialSkip) {
    errors.push(
      `backoff.cap (${config.backoff.cap}) must be >= backoff.initialSkip (${config.backoff.initialSkip})`,
    );
  }

  // Replacement
  validatePositive("replacement.maxResultTokens", config.replacement.maxResultTokens, errors);
  if (config.replacement.maxMessageTokens < config.replacement.maxResultTokens) {
    errors.push(
      `replacement.maxMessageTokens (${config.replacement.maxMessageTokens}) must be >= replacement.maxResultTokens (${config.replacement.maxResultTokens})`,
    );
  }
  validatePositive("replacement.previewChars", config.replacement.previewChars, errors);

  return errors;
}

/**
 * Config resolution and validation.
 *
 * Applies defaults to partial config, validates cross-field constraints.
 * Returns Result<ResolvedConfig, string[]> — errors are strings, not thrown.
 */

import type { InboundMessage, TokenEstimator } from "@koi/core";
import type { CompactionManagerConfig, ResolvedConfig } from "./types.js";
import { COMPACTION_DEFAULTS } from "./types.js";

/**
 * Fallback estimator used when no tokenEstimator is provided in config.
 * Matches the 4-chars-per-token heuristic from @koi/token-estimator.
 * Inlined to avoid runtime dependency — callers should inject the
 * real HEURISTIC_ESTIMATOR from @koi/token-estimator for production use.
 */
const FALLBACK_ESTIMATOR: TokenEstimator = {
  estimateText(text: string): number {
    return Math.ceil(text.length / 4);
  },
  estimateMessages(messages: readonly InboundMessage[]): number {
    let total = 0; // let: accumulator
    for (const msg of messages) {
      total += 4; // per-message overhead
      for (const block of msg.content) {
        if (block.kind === "text") {
          total += Math.ceil(block.text.length / 4);
        } else {
          total += 100; // non-text block overhead
        }
      }
    }
    return total;
  },
};

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
  const resolved: ResolvedConfig = {
    contextWindowSize: partial?.contextWindowSize ?? COMPACTION_DEFAULTS.contextWindowSize,
    preserveRecent: partial?.preserveRecent ?? COMPACTION_DEFAULTS.preserveRecent,
    tokenEstimator: partial?.tokenEstimator ?? FALLBACK_ESTIMATOR,
    micro: {
      triggerFraction: partial?.micro?.triggerFraction ?? COMPACTION_DEFAULTS.micro.triggerFraction,
      targetFraction: partial?.micro?.targetFraction ?? COMPACTION_DEFAULTS.micro.targetFraction,
      strategy: partial?.micro?.strategy ?? COMPACTION_DEFAULTS.micro.strategy,
    },
    full: {
      triggerFraction: partial?.full?.triggerFraction ?? COMPACTION_DEFAULTS.full.triggerFraction,
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

  const errors = validateResolvedConfig(resolved);
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

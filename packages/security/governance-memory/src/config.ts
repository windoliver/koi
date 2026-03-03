/**
 * Configuration validation for GovernanceMemoryConfig.
 *
 * Uses manual typeof + Result pattern consistent with existing codebase.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { GovernanceMemoryConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a governance memory configuration.
 *
 * Checks:
 * - config is a non-null object
 * - rules (if present) is an array of objects with required fields
 * - capacity values (if present) are positive integers
 * - getRecentAnomalies (if present) is a function
 * - elevateOnAnomalyKinds (if present) is an array of strings
 * - policyFingerprint (if present) is a string
 */
export function validateGovernanceMemoryConfig(
  config: unknown,
): Result<GovernanceMemoryConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  // Validate rules
  if (config.rules !== undefined) {
    if (!Array.isArray(config.rules)) {
      return validationError("'rules' must be an array");
    }
    for (const [idx, rule] of (config.rules as ReadonlyArray<unknown>).entries()) {
      const ruleResult = validateRule(rule, idx);
      if (!ruleResult.ok) return ruleResult;
    }
  }

  // Validate capacity fields
  if (config.complianceCapacity !== undefined) {
    if (
      typeof config.complianceCapacity !== "number" ||
      config.complianceCapacity <= 0 ||
      !Number.isInteger(config.complianceCapacity)
    ) {
      return validationError("'complianceCapacity' must be a positive integer");
    }
  }

  if (config.violationCapacity !== undefined) {
    if (
      typeof config.violationCapacity !== "number" ||
      config.violationCapacity <= 0 ||
      !Number.isInteger(config.violationCapacity)
    ) {
      return validationError("'violationCapacity' must be a positive integer");
    }
  }

  // Validate getRecentAnomalies
  if (config.getRecentAnomalies !== undefined && typeof config.getRecentAnomalies !== "function") {
    return validationError("'getRecentAnomalies' must be a function");
  }

  // Validate elevateOnAnomalyKinds
  if (config.elevateOnAnomalyKinds !== undefined) {
    if (!Array.isArray(config.elevateOnAnomalyKinds)) {
      return validationError("'elevateOnAnomalyKinds' must be an array");
    }
    for (const kind of config.elevateOnAnomalyKinds as ReadonlyArray<unknown>) {
      if (typeof kind !== "string") {
        return validationError("'elevateOnAnomalyKinds' entries must be strings");
      }
    }
  }

  // Validate policyFingerprint
  if (config.policyFingerprint !== undefined && typeof config.policyFingerprint !== "string") {
    return validationError("'policyFingerprint' must be a string");
  }

  // All validations passed — config shape is verified
  return { ok: true, value: config as GovernanceMemoryConfig };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateRule(rule: unknown, index: number): Result<true, KoiError> {
  if (!isRecord(rule)) {
    return validationError(`Rule at index ${index} must be a non-null object`);
  }

  if (typeof rule.id !== "string" || rule.id.length === 0) {
    return validationError(`Rule at index ${index} must have a non-empty 'id' string`);
  }

  if (rule.effect !== "permit" && rule.effect !== "forbid") {
    return validationError(`Rule "${String(rule.id)}" must have effect "permit" or "forbid"`);
  }

  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) {
    return validationError(`Rule "${String(rule.id)}" must have a finite 'priority' number`);
  }

  if (typeof rule.condition !== "function") {
    return validationError(`Rule "${String(rule.id)}" must have a 'condition' function`);
  }

  if (typeof rule.message !== "string") {
    return validationError(`Rule "${String(rule.id)}" must have a 'message' string`);
  }

  return { ok: true, value: true };
}

function validationError(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

/**
 * Guardrails middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { GuardrailsConfig } from "./types.js";

/** Default max buffer size for streaming validation (256KB). */
export const DEFAULT_MAX_BUFFER_SIZE = 262_144;

/** Default max retry attempts for "retry" action. */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 2;

const VALID_TARGETS = new Set(["modelOutput", "toolOutput"]);
const VALID_ACTIONS = new Set(["block", "warn", "retry"]);
const VALID_PARSE_MODES = new Set(["json", "text"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validateGuardrailsConfig(config: unknown): Result<GuardrailsConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  if (!Array.isArray(config.rules)) {
    return validationError("'rules' must be a non-empty array of GuardrailRule objects");
  }

  if (config.rules.length === 0) {
    return validationError("'rules' must be a non-empty array of GuardrailRule objects");
  }

  const seenNames = new Set<string>();
  // Array.isArray narrows to any[], assignable to readonly unknown[] without assertion
  const rules: readonly unknown[] = config.rules;
  for (const rule of rules) {
    if (!isRecord(rule)) {
      return validationError("Each rule must be a non-null object");
    }
    if (typeof rule.name !== "string" || rule.name.length === 0) {
      return validationError("Each rule must have a non-empty 'name' string");
    }
    if (seenNames.has(rule.name)) {
      return validationError(`Duplicate rule name: "${rule.name}"`);
    }
    seenNames.add(rule.name);
    if (rule.schema === undefined || rule.schema === null) {
      return validationError(`Rule "${String(rule.name)}": 'schema' is required`);
    }
    if (typeof rule.target !== "string" || !VALID_TARGETS.has(rule.target)) {
      return validationError(
        `Rule "${String(rule.name)}": 'target' must be "modelOutput" or "toolOutput"`,
      );
    }
    if (typeof rule.action !== "string" || !VALID_ACTIONS.has(rule.action)) {
      return validationError(
        `Rule "${String(rule.name)}": 'action' must be "block", "warn", or "retry"`,
      );
    }
    if (
      rule.parseMode !== undefined &&
      (typeof rule.parseMode !== "string" || !VALID_PARSE_MODES.has(rule.parseMode))
    ) {
      return validationError(`Rule "${String(rule.name)}": 'parseMode' must be "json" or "text"`);
    }
  }

  if (config.retry !== undefined) {
    if (!isRecord(config.retry)) {
      return validationError("'retry' must be an object");
    }
    if (config.retry.maxAttempts !== undefined) {
      if (
        typeof config.retry.maxAttempts !== "number" ||
        !Number.isInteger(config.retry.maxAttempts) ||
        config.retry.maxAttempts <= 0
      ) {
        return validationError("retry.maxAttempts must be a positive integer");
      }
    }
  }

  if (config.maxBufferSize !== undefined) {
    if (
      typeof config.maxBufferSize !== "number" ||
      !Number.isFinite(config.maxBufferSize) ||
      config.maxBufferSize <= 0
    ) {
      return validationError("maxBufferSize must be a finite positive number");
    }
  }

  if (config.onViolation !== undefined && typeof config.onViolation !== "function") {
    return validationError("onViolation must be a function");
  }

  // Validation-boundary cast: all fields individually verified above.
  // Matches established project pattern (see middleware-sanitize/src/config.ts:135-136).
  const validated: unknown = config;
  return { ok: true, value: validated as GuardrailsConfig };
}

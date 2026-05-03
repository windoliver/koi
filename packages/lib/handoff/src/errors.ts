/**
 * Error factories for @koi/handoff. Constructs KoiError values directly
 * (no @koi/errors dependency) — keeps the package L0u-free.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function notFoundError(id: string): KoiError {
  return {
    code: "NOT_FOUND",
    message: `Handoff envelope not found: ${id}`,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
    context: { resourceId: id },
  };
}

export function conflictError(id: string): KoiError {
  return {
    code: "CONFLICT",
    message: `Handoff envelope already exists: ${id}`,
    retryable: RETRYABLE_DEFAULTS.CONFLICT,
    context: { resourceId: id },
  };
}

export function validationError(message: string, context?: JsonObject): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    ...(context !== undefined ? { context } : {}),
  };
}

export function expiredError(id: string): KoiError {
  return {
    code: "NOT_FOUND",
    message: `Handoff envelope expired (TTL exceeded): ${id}`,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
    context: { resourceId: id, reason: "expired" },
  };
}

export function internalError(message: string, cause?: unknown): KoiError {
  return {
    code: "INTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
    ...(cause !== undefined ? { cause } : {}),
  };
}

export function externalError(message: string, cause?: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
    ...(cause !== undefined ? { cause } : {}),
  };
}

export function validateHandoffId(id: string): Result<void, KoiError> {
  if (id === "") {
    return { ok: false, error: validationError("Handoff ID must not be empty") };
  }
  return { ok: true, value: undefined };
}

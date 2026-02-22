/**
 * Shared error factory functions for artifact store implementations.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function notFoundError(id: string): KoiError {
  return {
    code: "NOT_FOUND",
    message: `Artifact not found: ${id}`,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
    context: { resourceId: id },
  };
}

export function conflictError(id: string): KoiError {
  return {
    code: "CONFLICT",
    message: `Artifact already exists: ${id}`,
    retryable: RETRYABLE_DEFAULTS.CONFLICT,
    context: { resourceId: id },
  };
}

export function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

export function internalError(message: string, cause?: unknown): KoiError {
  return {
    code: "INTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
    cause,
  };
}

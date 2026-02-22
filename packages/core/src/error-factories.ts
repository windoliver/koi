/**
 * Pure data constructors for KoiError objects.
 *
 * Eliminates duplication of error helper functions across store
 * implementations. Each factory is a zero-logic identity function
 * that returns a KoiError with correct code, retryability, and context.
 *
 * Exception: These are pure data constructors (like branded type casts),
 * permitted in L0 per architecture doc.
 */

import type { JsonObject } from "./common.js";
import type { KoiError } from "./errors.js";
import { RETRYABLE_DEFAULTS } from "./errors.js";

/** Resource not found. Non-retryable. */
export function notFound(resourceId: string, message?: string): KoiError {
  return {
    code: "NOT_FOUND",
    message: message ?? `Not found: ${resourceId}`,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
    context: { resourceId },
  };
}

/** Resource already exists. Retryable (with merge). */
export function conflict(resourceId: string, message?: string): KoiError {
  return {
    code: "CONFLICT",
    message: message ?? `Already exists: ${resourceId}`,
    retryable: RETRYABLE_DEFAULTS.CONFLICT,
    context: { resourceId },
  };
}

/** Invalid input or parameters. Non-retryable. */
export function validation(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

/** Unexpected internal error. Non-retryable. */
export function internal(message: string, cause?: unknown): KoiError {
  return {
    code: "INTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
    cause,
  };
}

/** Rate limit exceeded. Retryable (with backoff). */
export function rateLimit(message: string, context?: JsonObject): KoiError {
  const base: KoiError = {
    code: "RATE_LIMIT",
    message,
    retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
  };
  return context !== undefined ? { ...base, context } : base;
}

/** Operation timed out. Retryable (with backoff). */
export function timeout(message: string): KoiError {
  return {
    code: "TIMEOUT",
    message,
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
  };
}

/** Third-party service failure. Not retryable by default. */
export function external(message: string, cause?: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
    cause,
  };
}

/** Unauthorized action. Non-retryable. */
export function permission(message: string): KoiError {
  return {
    code: "PERMISSION",
    message,
    retryable: RETRYABLE_DEFAULTS.PERMISSION,
  };
}

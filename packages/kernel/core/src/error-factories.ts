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
  const base: KoiError = {
    code: "INTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
  };
  return cause !== undefined ? { ...base, cause } : base;
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
export function timeout(message: string, retryAfterMs?: number): KoiError {
  const base: KoiError = {
    code: "TIMEOUT",
    message,
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
  };
  return retryAfterMs !== undefined ? { ...base, retryAfterMs } : base;
}

/** Third-party service failure. Not retryable by default. */
export function external(message: string, cause?: unknown): KoiError {
  const base: KoiError = {
    code: "EXTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
  };
  return cause !== undefined ? { ...base, cause } : base;
}

/** Unauthorized action. Non-retryable. */
export function permission(message: string): KoiError {
  return {
    code: "PERMISSION",
    message,
    retryable: RETRYABLE_DEFAULTS.PERMISSION,
  };
}

/**
 * A cached reference has become invalid because the underlying resource changed.
 * Non-retryable as-is — the caller must re-acquire a fresh reference first.
 *
 * @param refId - The stale reference identifier (e.g., "e1", "cursor-42").
 * @param hint - Optional actionable hint for the caller (e.g., "call browser_snapshot").
 */
export function staleRef(refId: string, hint?: string): KoiError {
  const base = hint ?? "re-acquire a fresh reference before retrying";
  return {
    code: "STALE_REF",
    message: `Ref "${refId}" is stale — ${base}`,
    retryable: RETRYABLE_DEFAULTS.STALE_REF,
    context: { refId },
  };
}

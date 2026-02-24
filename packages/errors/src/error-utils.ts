/**
 * Shared error utilities for converting unknown values to KoiError.
 *
 * Centralizes extractMessage, extractCode, isKoiError, toKoiError, and
 * swallowError — previously duplicated across @koi/model-router and @koi/mcp.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

const VALID_CODES: ReadonlySet<string> = new Set<string>(Object.keys(RETRYABLE_DEFAULTS));

/** Extract a message string from an unknown error value. */
export function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** Extract an OS/system error code (e.g., ENOENT, SQLITE_BUSY) from an error. */
export function extractCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    return String((error as { readonly code: unknown }).code);
  }
  return undefined;
}

/** Type guard — validates value has all required KoiError fields with a valid code. */
export function isKoiError(error: unknown): error is KoiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retryable" in error &&
    typeof (error as Record<string, unknown>).message === "string" &&
    typeof (error as Record<string, unknown>).retryable === "boolean" &&
    VALID_CODES.has(String((error as Record<string, unknown>).code))
  );
}

/** Convert any thrown value to a KoiError. Returns as-is if already valid. */
export function toKoiError(error: unknown): KoiError {
  if (isKoiError(error)) return error;
  return {
    code: "EXTERNAL",
    message: extractMessage(error),
    retryable: false,
    cause: error,
  };
}

/** Log a non-critical error at warn level, then discard. Makes intent explicit. */
export function swallowError(
  error: unknown,
  context: { readonly package: string; readonly operation: string },
): void {
  const message = extractMessage(error);
  console.warn(`[${context.package}] ${context.operation} failed (swallowed): ${message}`);
}

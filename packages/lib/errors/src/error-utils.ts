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
  // Handle plain objects with a message property (e.g., KoiError data objects)
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  ) {
    return (error as Record<string, unknown>).message as string;
  }
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

/**
 * Format a tool execution error into a string suitable for sending back to the model.
 * Centralizes the error-to-string pattern previously duplicated across engine adapters.
 *
 * @param error - The caught error value (unknown).
 * @param toolId - The tool identifier for context.
 * @returns A formatted error string: `Tool '{toolId}' failed: {message}`.
 */
export function formatToolError(error: unknown, toolId: string): string {
  const message = extractMessage(error);
  return `Tool '${toolId}' failed: ${message}`;
}

/** Log a non-critical error at warn level, then discard. Makes intent explicit. */
export function swallowError(
  error: unknown,
  context: { readonly package: string; readonly operation: string },
): void {
  const message = extractMessage(error);
  console.warn(`[${context.package}] ${context.operation} failed (swallowed): ${message}`);
}

/**
 * Detect whether an error indicates the model's context window was exceeded.
 *
 * Checks provider-specific patterns:
 * - Anthropic: `type === "invalid_request_error"` + message contains "prompt is too long"
 * - OpenAI / OpenRouter: `code === "context_length_exceeded"`
 *
 * Accepts `unknown` so callers don't need to narrow first.
 */
export function isContextOverflowError(error: unknown): boolean {
  return checkContextOverflow(error, 0);
}

function checkContextOverflow(error: unknown, depth: number): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (depth > 1) return false; // cap nesting to prevent circular-reference stack overflow

  const err = error as Record<string, unknown>;

  // OpenAI / OpenRouter: { code: "context_length_exceeded" }
  if (err.code === "context_length_exceeded") return true;

  // Anthropic: { type: "invalid_request_error", message: "...prompt is too long..." }
  if (
    err.type === "invalid_request_error" &&
    typeof err.message === "string" &&
    err.message.includes("prompt is too long")
  ) {
    return true;
  }

  // Nested error.error shape (common in raw API responses)
  if (typeof err.error === "object" && err.error !== null) {
    return checkContextOverflow(err.error, depth + 1);
  }

  return false;
}

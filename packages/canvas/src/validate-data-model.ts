/**
 * JSON Pointer (RFC 6901) validation and parsing.
 */

import type { KoiError, Result } from "@koi/core";

/** A parsed JSON Pointer as an array of unescaped reference tokens. */
export type JsonPointerTokens = readonly string[];

/**
 * Validates and parses a JSON Pointer string per RFC 6901.
 *
 * A valid pointer must:
 * - Be exactly "" (empty — root) or start with "/"
 * - Use "~0" for "~" and "~1" for "/" in tokens
 */
export function parseJsonPointer(pointer: string): Result<JsonPointerTokens, KoiError> {
  if (pointer === "") {
    return { ok: true, value: [] };
  }

  if (!pointer.startsWith("/")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid JSON Pointer: must start with "/" or be empty, got "${pointer}"`,
        retryable: false,
        context: { pointer },
      },
    };
  }

  // Check for invalid escape sequences: ~ not followed by 0 or 1
  const invalidEscape = /~(?![01])/;
  if (invalidEscape.test(pointer)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid JSON Pointer: invalid escape sequence in "${pointer}"`,
        retryable: false,
        context: { pointer },
      },
    };
  }

  const tokens = pointer
    .slice(1) // remove leading "/"
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));

  return { ok: true, value: tokens };
}

/**
 * Validates that a JSON Pointer string conforms to RFC 6901.
 * Returns true if valid, false otherwise.
 */
export function isValidJsonPointer(pointer: string): boolean {
  return parseJsonPointer(pointer).ok;
}

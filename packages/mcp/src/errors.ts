/**
 * Error mapping from MCP SDK errors to KoiError.
 *
 * Single boundary function that pattern-matches error messages to produce
 * appropriate KoiError codes with retryability information.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

// ---------------------------------------------------------------------------
// Error message patterns
// ---------------------------------------------------------------------------

interface ErrorPattern {
  readonly pattern: RegExp;
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
}

const ERROR_PATTERNS: readonly ErrorPattern[] = [
  { pattern: /rate.?limit/i, code: "RATE_LIMIT", retryable: true },
  { pattern: /too many requests/i, code: "RATE_LIMIT", retryable: true },
  { pattern: /\b429\b/, code: "RATE_LIMIT", retryable: true },
  { pattern: /timeout/i, code: "TIMEOUT", retryable: true },
  { pattern: /timed?\s*out/i, code: "TIMEOUT", retryable: true },
  { pattern: /ETIMEDOUT/i, code: "TIMEOUT", retryable: true },
  { pattern: /connection.?(closed|reset|refused|aborted)/i, code: "EXTERNAL", retryable: true },
  { pattern: /ECONNR(ESET|EFUSED)/i, code: "EXTERNAL", retryable: true },
  { pattern: /EPIPE/i, code: "EXTERNAL", retryable: true },
  { pattern: /socket hang up/i, code: "EXTERNAL", retryable: true },
  { pattern: /unauthorized/i, code: "PERMISSION", retryable: false },
  { pattern: /forbidden/i, code: "PERMISSION", retryable: false },
  { pattern: /\b401\b/, code: "PERMISSION", retryable: false },
  { pattern: /\b403\b/, code: "PERMISSION", retryable: false },
  { pattern: /not.?found/i, code: "NOT_FOUND", retryable: false },
  { pattern: /unknown tool/i, code: "NOT_FOUND", retryable: false },
  { pattern: /invalid/i, code: "VALIDATION", retryable: false },
  { pattern: /validation/i, code: "VALIDATION", retryable: false },
] as const;

// ---------------------------------------------------------------------------
// Core mapping function
// ---------------------------------------------------------------------------

/** Extracts a message string from an unknown error value. */
function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

/**
 * Maps an MCP SDK error to a KoiError.
 *
 * Pattern-matches the error message against known patterns to determine
 * the appropriate error code and retryability. Falls back to EXTERNAL
 * for unrecognized errors.
 */
export function mapMcpError(error: unknown, serverName: string): KoiError {
  const message = extractMessage(error);

  for (const { pattern, code, retryable } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code,
        message: `MCP server "${serverName}": ${message}`,
        retryable,
        cause: error instanceof Error ? error : undefined,
        context: { serverName },
      };
    }
  }

  return {
    code: "EXTERNAL",
    message: `MCP server "${serverName}": ${message}`,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
    cause: error instanceof Error ? error : undefined,
    context: { serverName },
  };
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Creates a connection timeout error for a specific server. */
export function connectionTimeoutError(serverName: string, timeoutMs: number): KoiError {
  return {
    code: "TIMEOUT",
    message: `MCP server "${serverName}": connection timed out after ${timeoutMs}ms`,
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
    context: { serverName, timeoutMs },
  };
}

/** Creates a server start error for a specific server. */
export function serverStartError(serverName: string, cause: unknown): KoiError {
  const message = extractMessage(cause);
  return {
    code: "EXTERNAL",
    message: `MCP server "${serverName}": failed to start: ${message}`,
    retryable: false,
    cause: cause instanceof Error ? cause : undefined,
    context: { serverName },
  };
}

/** Creates an error for when a server is not connected. */
export function notConnectedError(serverName: string): KoiError {
  return {
    code: "EXTERNAL",
    message: `MCP server "${serverName}": not connected`,
    retryable: true,
    context: { serverName },
  };
}

/** Creates an error for exhausted reconnection attempts. */
export function reconnectExhaustedError(serverName: string, attempts: number): KoiError {
  return {
    code: "EXTERNAL",
    message: `MCP server "${serverName}": reconnection failed after ${attempts} attempts`,
    retryable: false,
    context: { serverName, attempts },
  };
}

/**
 * Error factories and mapping for LSP errors.
 *
 * Maps LSP JSON-RPC error codes and common failure modes to KoiError.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { extractMessage } from "@koi/errors";

// ---------------------------------------------------------------------------
// LSP error code mapping
// ---------------------------------------------------------------------------

interface ErrorPattern {
  readonly pattern: RegExp;
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
}

const ERROR_PATTERNS: readonly ErrorPattern[] = [
  { pattern: /timeout/i, code: "TIMEOUT", retryable: true },
  { pattern: /timed?\s*out/i, code: "TIMEOUT", retryable: true },
  { pattern: /ETIMEDOUT/i, code: "TIMEOUT", retryable: true },
  { pattern: /connection.?(closed|reset|refused|aborted)/i, code: "EXTERNAL", retryable: true },
  { pattern: /ECONNR(ESET|EFUSED)/i, code: "EXTERNAL", retryable: true },
  { pattern: /EPIPE/i, code: "EXTERNAL", retryable: true },
  { pattern: /ENOENT/i, code: "NOT_FOUND", retryable: false },
  { pattern: /spawn/i, code: "EXTERNAL", retryable: false },
  { pattern: /not.?found/i, code: "NOT_FOUND", retryable: false },
  { pattern: /invalid/i, code: "VALIDATION", retryable: false },
  { pattern: /method.?not.?found/i, code: "NOT_FOUND", retryable: false },
] as const;

// ---------------------------------------------------------------------------
// Core mapping function
// ---------------------------------------------------------------------------

/**
 * Maps an LSP / JSON-RPC error to a KoiError.
 *
 * Pattern-matches the error message to determine the appropriate code
 * and retryability. Falls back to EXTERNAL for unrecognized errors.
 */
export function mapLspError(error: unknown, serverName: string): KoiError {
  const message = extractMessage(error);

  for (const { pattern, code, retryable } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code,
        message: `LSP server "${serverName}": ${message}`,
        retryable,
        cause: error instanceof Error ? error : undefined,
        context: { serverName },
      };
    }
  }

  return {
    code: "EXTERNAL",
    message: `LSP server "${serverName}": ${message}`,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
    cause: error instanceof Error ? error : undefined,
    context: { serverName },
  };
}

// ---------------------------------------------------------------------------
// Connection error detection
// ---------------------------------------------------------------------------

/**
 * Returns true if an error looks like a connection-level failure that
 * should trigger a reconnect attempt. Single source of truth used by
 * lifecycle.ts withConnection.
 */
export function isConnectionError(e: unknown): boolean {
  const message = extractMessage(e);
  return /disposed|EPIPE|ECONNR|connection.*(closed|reset)|ECONNABORTED/i.test(message);
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Creates a connection timeout error for a specific server. */
export function connectionTimeoutError(serverName: string, timeoutMs: number): KoiError {
  return {
    code: "TIMEOUT",
    message: `LSP server "${serverName}": connection timed out after ${timeoutMs}ms`,
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
    context: { serverName, timeoutMs },
  };
}

/** Creates a server start error for a specific server. */
export function serverStartError(serverName: string, cause: unknown): KoiError {
  const message = extractMessage(cause);
  return {
    code: "EXTERNAL",
    message: `LSP server "${serverName}": failed to start: ${message}`,
    retryable: false,
    cause: cause instanceof Error ? cause : undefined,
    context: { serverName },
  };
}

/** Creates an error for when a server is not connected. */
export function notConnectedError(serverName: string): KoiError {
  return {
    code: "EXTERNAL",
    message: `LSP server "${serverName}": not connected`,
    retryable: true,
    context: { serverName },
  };
}

/** Creates an error for exhausted reconnection attempts. */
export function reconnectExhaustedError(serverName: string, attempts: number): KoiError {
  return {
    code: "EXTERNAL",
    message: `LSP server "${serverName}": reconnection failed after ${attempts} attempts`,
    retryable: false,
    context: { serverName, attempts },
  };
}

/** Creates an error for a JSON-RPC error response. */
export function jsonRpcError(serverName: string, code: number, message: string): KoiError {
  return {
    code: "EXTERNAL",
    message: `LSP server "${serverName}": JSON-RPC error ${code}: ${message}`,
    retryable: false,
    context: { serverName, jsonRpcCode: code },
  };
}

/** Creates an error for capability not supported. */
export function capabilityNotSupportedError(serverName: string, capability: string): KoiError {
  return {
    code: "VALIDATION",
    message: `LSP server "${serverName}": capability "${capability}" is not supported`,
    retryable: false,
    context: { serverName, capability },
  };
}

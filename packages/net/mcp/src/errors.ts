/**
 * Structured error mapping from MCP SDK / HTTP errors to KoiError.
 *
 * Strategy: check structured signals first (HTTP status code, JSON-RPC error
 * code), then fall back to message pattern matching for unstructured errors.
 * This is more reliable than regex-only matching because HTTP status codes
 * and JSON-RPC codes are part of the protocol contract.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { extractMessage } from "@koi/errors";

// ---------------------------------------------------------------------------
// HTTP status code mapping (Streamable HTTP transport)
// ---------------------------------------------------------------------------

interface StatusMapping {
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
}

const HTTP_STATUS_MAP: Readonly<Record<number, StatusMapping>> = {
  400: { code: "VALIDATION", retryable: false },
  401: { code: "PERMISSION", retryable: false },
  403: { code: "PERMISSION", retryable: false },
  404: { code: "NOT_FOUND", retryable: false },
  408: { code: "TIMEOUT", retryable: true },
  409: { code: "CONFLICT", retryable: true },
  429: { code: "RATE_LIMIT", retryable: true },
  500: { code: "EXTERNAL", retryable: true },
  502: { code: "EXTERNAL", retryable: true },
  503: { code: "EXTERNAL", retryable: true },
  504: { code: "TIMEOUT", retryable: true },
};

// ---------------------------------------------------------------------------
// JSON-RPC error code mapping (MCP protocol layer)
// ---------------------------------------------------------------------------

const JSONRPC_CODE_MAP: Readonly<Record<number, StatusMapping>> = {
  [-32700]: { code: "VALIDATION", retryable: false }, // Parse error
  [-32600]: { code: "VALIDATION", retryable: false }, // Invalid request
  [-32601]: { code: "NOT_FOUND", retryable: false }, // Method not found
  [-32602]: { code: "VALIDATION", retryable: false }, // Invalid params
  [-32603]: { code: "EXTERNAL", retryable: true }, // Internal error
};

// ---------------------------------------------------------------------------
// Message pattern fallback (last resort)
// ---------------------------------------------------------------------------

interface ErrorPattern {
  readonly pattern: RegExp;
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
}

const MESSAGE_PATTERNS: readonly ErrorPattern[] = [
  { pattern: /rate.?limit/i, code: "RATE_LIMIT", retryable: true },
  { pattern: /too many requests/i, code: "RATE_LIMIT", retryable: true },
  { pattern: /timeout/i, code: "TIMEOUT", retryable: true },
  { pattern: /timed?\s*out/i, code: "TIMEOUT", retryable: true },
  { pattern: /ETIMEDOUT/, code: "TIMEOUT", retryable: true },
  {
    pattern: /connection.?(closed|reset|refused|aborted)/i,
    code: "EXTERNAL",
    retryable: true,
  },
  { pattern: /ECONNR(ESET|EFUSED)/, code: "EXTERNAL", retryable: true },
  { pattern: /EPIPE/, code: "EXTERNAL", retryable: true },
  { pattern: /socket hang up/i, code: "EXTERNAL", retryable: true },
  { pattern: /unauthorized/i, code: "PERMISSION", retryable: false },
  { pattern: /forbidden/i, code: "PERMISSION", retryable: false },
  { pattern: /not.?found/i, code: "NOT_FOUND", retryable: false },
  { pattern: /unknown tool/i, code: "NOT_FOUND", retryable: false },
];

// ---------------------------------------------------------------------------
// Core mapping function
// ---------------------------------------------------------------------------

export interface McpErrorContext {
  readonly serverName: string;
  readonly httpStatus?: number | undefined;
  readonly jsonRpcCode?: number | undefined;
}

/**
 * Maps an MCP error to a KoiError using structured signals first,
 * then message pattern fallback.
 *
 * Priority: HTTP status code > JSON-RPC code > message pattern > EXTERNAL fallback
 */
function buildKoiError(
  error: unknown,
  serverName: string,
  mapping: StatusMapping,
  msg: string,
): KoiError {
  return {
    code: mapping.code,
    message: msg,
    retryable: mapping.retryable,
    cause: error instanceof Error ? error : undefined,
    context: { serverName },
  };
}

export function mapMcpError(error: unknown, context: McpErrorContext): KoiError {
  const message = extractMessage(error);
  const { serverName } = context;

  // 1. HTTP status code (most reliable for Streamable HTTP)
  if (context.httpStatus !== undefined) {
    const m = HTTP_STATUS_MAP[context.httpStatus];
    if (m !== undefined) {
      return buildKoiError(
        error,
        serverName,
        m,
        `MCP server "${serverName}": HTTP ${context.httpStatus} — ${message}`,
      );
    }
  }

  // 2. JSON-RPC error code (protocol-level structured error)
  if (context.jsonRpcCode !== undefined) {
    const m = JSONRPC_CODE_MAP[context.jsonRpcCode];
    if (m !== undefined) {
      return buildKoiError(
        error,
        serverName,
        m,
        `MCP server "${serverName}": JSON-RPC ${context.jsonRpcCode} — ${message}`,
      );
    }
  }

  // 3. Message pattern matching (fallback)
  for (const { pattern, code, retryable } of MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return buildKoiError(
        error,
        serverName,
        { code, retryable },
        `MCP server "${serverName}": ${message}`,
      );
    }
  }

  // 4. Unknown — default to EXTERNAL
  return buildKoiError(
    error,
    serverName,
    { code: "EXTERNAL", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
    `MCP server "${serverName}": ${message}`,
  );
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function connectionTimeoutError(serverName: string, timeoutMs: number): KoiError {
  return {
    code: "TIMEOUT",
    message: `MCP server "${serverName}": connection timed out after ${timeoutMs}ms`,
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
    context: { serverName, timeoutMs },
  };
}

export function notConnectedError(serverName: string): KoiError {
  return {
    code: "EXTERNAL",
    message: `MCP server "${serverName}": not connected`,
    retryable: true,
    context: { serverName },
  };
}

export function reconnectExhaustedError(serverName: string, attempts: number): KoiError {
  return {
    code: "EXTERNAL",
    message: `MCP server "${serverName}": reconnection failed after ${attempts} attempts`,
    retryable: false,
    context: { serverName, attempts },
  };
}

export function sessionExpiredError(serverName: string): KoiError {
  return {
    code: "EXTERNAL",
    message: `MCP server "${serverName}": session expired (404), must re-initialize`,
    retryable: true,
    context: { serverName },
  };
}

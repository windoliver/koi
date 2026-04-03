/**
 * Centralized error mapping for Nexus JSON-RPC responses.
 *
 * Maps JSON-RPC error codes, HTTP status codes, and network errors
 * to KoiError with correct retryability flags.
 */

import type { JsonObject, KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

// ---------------------------------------------------------------------------
// Nexus JSON-RPC error codes
// ---------------------------------------------------------------------------

/** Nexus METHOD_NOT_FOUND — used as fallback signal for edit/search. */
export const METHOD_NOT_FOUND_CODE = -32601;

/** JSON-RPC code → KoiErrorCode mapping. */
const RPC_CODE_MAP: Readonly<
  Record<number, { readonly code: KoiErrorCode; readonly retryable: boolean }>
> = {
  [-32000]: { code: "NOT_FOUND", retryable: false }, // FILE_NOT_FOUND
  [-32001]: { code: "CONFLICT", retryable: false }, // FILE_EXISTS
  [-32002]: { code: "VALIDATION", retryable: false }, // INVALID_PATH
  [-32003]: { code: "PERMISSION", retryable: false }, // ACCESS_DENIED
  [-32004]: { code: "PERMISSION", retryable: false }, // PERMISSION_ERROR
  [-32005]: { code: "VALIDATION", retryable: false }, // VALIDATION_ERROR
  [-32006]: { code: "CONFLICT", retryable: true }, // OCC CONFLICT
  [METHOD_NOT_FOUND_CODE]: { code: "EXTERNAL", retryable: false },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a Nexus error (JSON-RPC error object, HTTP error, or network error)
 * to a KoiError with appropriate code and retryability.
 */
export function mapNexusError(error: unknown, operation: string): KoiError {
  const ctx: JsonObject = { operation };

  // Abort errors first (DOMException has .code + .message, so isRpcError would match)
  if (isAbortError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: "TIMEOUT",
      message: `Network error during ${operation}: ${message}`,
      retryable: true,
      cause: error,
      context: ctx,
    };
  }

  // JSON-RPC error object: { code: number, message: string }
  if (isRpcError(error)) {
    const mapping = RPC_CODE_MAP[error.code];
    if (mapping !== undefined) {
      return {
        code: mapping.code,
        message: error.message,
        retryable: mapping.retryable,
        cause: error,
        context: { ...ctx, rpcCode: error.code },
      };
    }
    // Unknown RPC code
    return {
      code: "EXTERNAL",
      message: error.message,
      retryable: RETRYABLE_DEFAULTS.EXTERNAL,
      cause: error,
      context: { ...ctx, rpcCode: error.code },
    };
  }

  // HTTP error: { status: number, statusText: string }
  if (isHttpError(error)) {
    if (error.status === 429) {
      return {
        code: "RATE_LIMIT",
        message: `Rate limited: ${error.statusText}`,
        retryable: true,
        cause: error,
        context: { ...ctx, httpStatus: error.status },
      };
    }
    if (error.status >= 500) {
      return {
        code: "INTERNAL",
        message: `Server error: ${String(error.status)} ${error.statusText}`,
        retryable: true,
        cause: error,
        context: { ...ctx, httpStatus: error.status },
      };
    }
    return {
      code: "EXTERNAL",
      message: `HTTP ${String(error.status)}: ${error.statusText}`,
      retryable: false,
      cause: error,
      context: { ...ctx, httpStatus: error.status },
    };
  }

  // Network errors (fetch failures)
  if (error instanceof TypeError) {
    return {
      code: "TIMEOUT",
      message: `Network error during ${operation}: ${error.message}`,
      retryable: true,
      cause: error,
      context: ctx,
    };
  }

  // Generic Error
  if (error instanceof Error) {
    return {
      code: "EXTERNAL",
      message: `${operation}: ${error.message}`,
      retryable: true,
      cause: error,
      context: ctx,
    };
  }

  // Unknown
  return {
    code: "EXTERNAL",
    message: `${operation}: ${String(error)}`,
    retryable: false,
    cause: error,
    context: ctx,
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isRpcError(e: unknown): e is { readonly code: number; readonly message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as Record<string, unknown>).code === "number" &&
    "message" in e &&
    typeof (e as Record<string, unknown>).message === "string"
  );
}

function isHttpError(e: unknown): e is { readonly status: number; readonly statusText: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    typeof (e as Record<string, unknown>).status === "number" &&
    "statusText" in e
  );
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

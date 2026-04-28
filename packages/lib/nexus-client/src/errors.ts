import type { JsonObject, KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Nexus METHOD_NOT_FOUND — used as fallback signal for edit/search. */
export const METHOD_NOT_FOUND_CODE = -32601;

/**
 * JSON-RPC code → KoiErrorCode mapping.
 * Must stay in sync with bridge.py "JSON-RPC error codes" section.
 */
const RPC_CODE_MAP: Readonly<
  Record<number, { readonly code: KoiErrorCode; readonly retryable: boolean }>
> = {
  [-32000]: { code: "NOT_FOUND", retryable: false },
  [-32001]: { code: "CONFLICT", retryable: false },
  [-32002]: { code: "VALIDATION", retryable: false },
  [-32003]: { code: "PERMISSION", retryable: false },
  [-32004]: { code: "PERMISSION", retryable: false },
  [-32005]: { code: "VALIDATION", retryable: false },
  [-32006]: { code: "CONFLICT", retryable: true },
  [-32007]: { code: "AUTH_REQUIRED", retryable: false },
  [METHOD_NOT_FOUND_CODE]: { code: "EXTERNAL", retryable: false },
};

export function mapNexusError(error: unknown, operation: string): KoiError {
  const ctx: JsonObject = { operation };

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
    return {
      code: "EXTERNAL",
      message: error.message,
      retryable: RETRYABLE_DEFAULTS.EXTERNAL,
      cause: error,
      context: { ...ctx, rpcCode: error.code },
    };
  }

  if (isHttpError(error)) {
    if (error.status === 429) {
      return {
        code: "RATE_LIMIT",
        message: `Rate limited during ${operation}`,
        retryable: true,
        cause: error,
        context: { ...ctx, httpStatus: error.status },
      };
    }
    if (error.status >= 500) {
      return {
        code: "INTERNAL",
        message: `Server error ${String(error.status)} during ${operation}`,
        retryable: true,
        cause: error,
        context: { ...ctx, httpStatus: error.status },
      };
    }
    return {
      code: "EXTERNAL",
      message: `HTTP ${String(error.status)} during ${operation}`,
      retryable: false,
      cause: error,
      context: { ...ctx, httpStatus: error.status },
    };
  }

  if (error instanceof TypeError) {
    return {
      code: "TIMEOUT",
      message: `Network error during ${operation}: ${error.message}`,
      retryable: true,
      cause: error,
      context: ctx,
    };
  }

  if (error instanceof Error) {
    return {
      code: "EXTERNAL",
      message: `${operation}: ${error.message}`,
      retryable: true,
      cause: error,
      context: ctx,
    };
  }

  return {
    code: "EXTERNAL",
    message: `${operation}: ${String(error)}`,
    retryable: false,
    cause: error,
    context: ctx,
  };
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

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

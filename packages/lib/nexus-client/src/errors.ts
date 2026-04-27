import type { KoiError } from "@koi/core";

export function mapNexusError(error: unknown, operation: string): KoiError {
  if (isAbortError(error)) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      code: "TIMEOUT",
      message: `Network timeout during ${operation}: ${msg}`,
      retryable: true,
      cause: error,
    };
  }
  if (isRpcError(error)) {
    return {
      code: "EXTERNAL",
      message: error.message,
      retryable: false,
      cause: error,
      context: { operation, rpcCode: error.code },
    };
  }
  if (isHttpError(error)) {
    if (error.status === 429) {
      return {
        code: "RATE_LIMIT",
        message: `Rate limited during ${operation}`,
        retryable: true,
        cause: error,
      };
    }
    if (error.status >= 500) {
      return {
        code: "INTERNAL",
        message: `Server error ${String(error.status)} during ${operation}`,
        retryable: true,
        cause: error,
      };
    }
    return {
      code: "EXTERNAL",
      message: `HTTP ${String(error.status)} during ${operation}`,
      retryable: false,
      cause: error,
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "TIMEOUT",
      message: `Network error during ${operation}: ${error.message}`,
      retryable: true,
      cause: error,
    };
  }
  if (error instanceof Error) {
    return {
      code: "EXTERNAL",
      message: `${operation}: ${error.message}`,
      retryable: true,
      cause: error,
    };
  }
  return {
    code: "EXTERNAL",
    message: `${operation}: ${String(error)}`,
    retryable: false,
    cause: error,
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
    typeof (e as Record<string, unknown>).status === "number"
  );
}

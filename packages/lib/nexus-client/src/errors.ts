/**
 * Error mapping for Nexus JSON-RPC 2.0 transport.
 *
 * Maps HTTP status codes and JSON-RPC error codes to KoiError.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Map an HTTP error status to a KoiError. */
export function mapHttpError(status: number, message: string): KoiError {
  if (status === 404) {
    return { code: "NOT_FOUND", message, retryable: RETRYABLE_DEFAULTS.NOT_FOUND };
  }
  if (status === 403 || status === 401) {
    return { code: "PERMISSION", message, retryable: RETRYABLE_DEFAULTS.PERMISSION };
  }
  if (status === 409) {
    return { code: "CONFLICT", message, retryable: RETRYABLE_DEFAULTS.CONFLICT };
  }
  if (status === 429) {
    return { code: "RATE_LIMIT", message, retryable: RETRYABLE_DEFAULTS.RATE_LIMIT };
  }
  return { code: "EXTERNAL", message, retryable: true };
}

/** Map a JSON-RPC error response to a KoiError. */
export function mapRpcError(rpcError: {
  readonly code: number;
  readonly message: string;
}): KoiError {
  // JSON-RPC error codes: -32600..-32603 are protocol errors, app-specific are positive
  if (rpcError.code === -32601) {
    return {
      code: "EXTERNAL",
      message: `RPC method not found: ${rpcError.message}`,
      retryable: false,
    };
  }
  return { code: "EXTERNAL", message: rpcError.message, retryable: true };
}

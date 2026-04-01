/**
 * Map Anthropic SDK errors to KoiRuntimeError.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { KoiErrorCode } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

/** Map an HTTP status code to a KoiErrorCode. */
export function mapStatusToKoiCode(status: number | undefined): KoiErrorCode {
  if (status === undefined) return "EXTERNAL";
  if (status === 401) return "PERMISSION";
  if (status === 403) return "PERMISSION";
  if (status === 404) return "NOT_FOUND";
  if (status === 429 || status === 529) return "RATE_LIMIT";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "EXTERNAL";
  return "EXTERNAL";
}

/** Determine if an HTTP status indicates a retryable error. */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || status === 529 || status >= 500;
}

/** Extract retry-after header value in milliseconds from SDK error headers. */
function parseRetryAfterFromHeaders(headers: Headers | undefined): number | undefined {
  if (headers === undefined) return undefined;
  const value = headers.get("retry-after");
  if (value === null) return undefined;

  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;

  // Try parsing as HTTP date
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}

/**
 * Map an unknown error (typically from the Anthropic SDK) to a KoiRuntimeError.
 *
 * Handles:
 * - SDK APIError subclasses (with status codes and headers)
 * - AbortError (signal cancellation)
 * - Generic errors
 */
export function mapAnthropicError(error: unknown): KoiRuntimeError {
  if (error instanceof Anthropic.APIError) {
    const code = mapStatusToKoiCode(error.status);
    const retryAfterMs = parseRetryAfterFromHeaders(error.headers as Headers | undefined);

    return KoiRuntimeError.from(code, error.message, {
      cause: error,
      retryable: isRetryableStatus(error.status),
      context: { statusCode: error.status },
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  // AbortError from signal cancellation
  if (error instanceof DOMException && error.name === "AbortError") {
    return KoiRuntimeError.from("TIMEOUT", "Request aborted", {
      cause: error,
      retryable: false,
    });
  }

  // Generic error fallback
  const message = error instanceof Error ? error.message : String(error);
  return KoiRuntimeError.from("EXTERNAL", `Anthropic client error: ${message}`, {
    cause: error,
    retryable: false,
  });
}

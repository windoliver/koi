/**
 * Error normalization — HTTP status codes and provider errors → KoiError.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/**
 * Map an HTTP status code to the appropriate KoiErrorCode.
 * Covers the standard error classes; callers can override for vendor quirks.
 */
export function mapHttpStatusToKoiCode(status: number): KoiErrorCode {
  if (status === 401 || status === 403) return "PERMISSION";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status >= 500) return "EXTERNAL";
  return "EXTERNAL";
}

/**
 * Parse `Retry-After` header into milliseconds.
 * Supports both seconds (numeric) and HTTP-date formats.
 * Returns `undefined` if the header is absent or unparseable.
 */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;

  // Try numeric seconds first
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  // Try HTTP-date
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

/**
 * BackendErrorMapper implementation for OpenRouter/OpenAI-compatible providers.
 * Produces a structured KoiError from HTTP response details.
 */
export function mapProviderError(
  status: number,
  body: string,
  headers: Headers,
  context: string,
): KoiError {
  const code = mapHttpStatusToKoiCode(status);
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"));

  // Try to extract a structured error message from the response body
  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err = (parsed as { readonly error: unknown }).error;
      if (typeof err === "object" && err !== null && "message" in err) {
        detail = String((err as { readonly message: unknown }).message);
      } else if (typeof err === "string") {
        detail = err;
      }
    }
  } catch {
    // body is not JSON, use as-is
  }

  const message = `${context}: ${detail}`;

  const base: KoiError = {
    code,
    message,
    retryable: code === "RATE_LIMIT" || code === "TIMEOUT" || RETRYABLE_DEFAULTS[code],
  };

  if (retryAfterMs !== undefined) {
    return { ...base, retryAfterMs };
  }

  return base;
}

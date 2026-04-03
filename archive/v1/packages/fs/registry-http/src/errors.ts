/**
 * HTTP status → KoiError mapping for registry responses.
 */

import type { KoiError } from "@koi/core";

// ---------------------------------------------------------------------------
// Status code mapping
// ---------------------------------------------------------------------------

/** Map HTTP status codes to structured KoiError. */
export function mapHttpError(status: number, body: string, url: string): KoiError {
  if (status === 404) {
    return {
      code: "NOT_FOUND",
      message: `Skill not found at ${url}`,
      retryable: false,
      context: { status, url },
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: "PERMISSION",
      message: `Authorization failed for ${url}: ${status}`,
      retryable: false,
      context: { status, url },
    };
  }

  if (status === 409) {
    return {
      code: "CONFLICT",
      message: `Conflict at ${url}: ${body}`,
      retryable: false,
      context: { status, url },
    };
  }

  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: `Rate limited at ${url}`,
      retryable: true,
      context: { status, url },
    };
  }

  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `Server error ${status} from ${url}: ${body}`,
      retryable: true,
      context: { status, url },
    };
  }

  return {
    code: "EXTERNAL",
    message: `Unexpected HTTP ${status} from ${url}: ${body}`,
    retryable: false,
    context: { status, url },
  };
}

/** Create a KoiError for network failures. */
export function mapNetworkError(error: unknown, url: string): KoiError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "EXTERNAL",
    message: `Network error contacting ${url}: ${message}`,
    retryable: true,
    context: { url },
  };
}

/**
 * Maps Nexus HTTP status codes to KoiError.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function mapNexusHttpError(status: number, context: string): KoiError {
  if (status === 400) {
    return {
      code: "VALIDATION",
      message: `Nexus search validation error: ${context}`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
      context: { status },
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: "PERMISSION",
      message: `Nexus search auth error: ${context}`,
      retryable: RETRYABLE_DEFAULTS.PERMISSION,
      context: { status },
    };
  }

  if (status === 404) {
    return {
      code: "NOT_FOUND",
      message: `Nexus search endpoint not found: ${context}`,
      retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
      context: { status },
    };
  }

  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: `Nexus search rate limited: ${context}`,
      retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
      context: { status },
    };
  }

  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `Nexus search server error (${status}): ${context}`,
      retryable: true,
      context: { status },
    };
  }

  return {
    code: "EXTERNAL",
    message: `Nexus search unexpected status (${status}): ${context}`,
    retryable: false,
    context: { status },
  };
}

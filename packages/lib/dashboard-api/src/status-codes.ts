import type { KoiErrorCode } from "@koi/core";

/**
 * HTTP status for each `KoiErrorCode`. Mirrors REST conventions —
 * client errors map to 4xx, server/transient failures to 5xx.
 *
 * Used at the dashboard-api boundary to translate structured `KoiError`
 * codes returned by `DashboardDataSource` into wire status codes.
 */
export function statusForCode(code: KoiErrorCode): number {
  switch (code) {
    case "VALIDATION":
    case "INVALID_BODY":
    case "INVALID_CONFIG":
      return 400;
    case "AUTH_REQUIRED":
      return 401;
    case "PERMISSION":
      return 403;
    case "NOT_FOUND":
    case "STALE_REF":
      return 404;
    case "CONFLICT":
    case "ALREADY_RUNNING":
      return 409;
    case "RATE_LIMIT":
      return 429;
    case "TIMEOUT":
    case "HEARTBEAT_TIMEOUT":
      return 504;
    case "UNAVAILABLE":
    case "RESOURCE_EXHAUSTED":
      return 503;
    case "EXTERNAL":
    case "INTERNAL":
      return 500;
    default: {
      const exhaustive: never = code;
      void exhaustive;
      return 500;
    }
  }
}

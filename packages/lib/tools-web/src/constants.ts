/**
 * Constants for @koi/tools-web.
 */

export const WEB_OPERATIONS = ["fetch", "search"] as const;
export type WebOperation = (typeof WEB_OPERATIONS)[number];

export const DEFAULT_WEB_PREFIX = "web";
export const DEFAULT_MAX_BODY_CHARS = 50_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_REDIRECTS = 10;
export const DEFAULT_CACHE_TTL_MS = 0;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;

export const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export const CROSS_ORIGIN_SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-amz-security-token",
  "x-auth-token",
  "x-csrf-token",
  "x-forwarded-for",
]);

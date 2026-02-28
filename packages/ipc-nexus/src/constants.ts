/**
 * Constants for @koi/ipc-nexus — tool names, defaults, and operation types.
 */

/** Default Nexus IPC server base URL. */
export const DEFAULT_NEXUS_BASE_URL = "http://localhost:2026" as const;

/** Default HTTP request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Minimum polling interval in milliseconds. */
export const DEFAULT_POLL_MIN_MS = 1_000;

/** Maximum polling interval in milliseconds (backoff ceiling). */
export const DEFAULT_POLL_MAX_MS = 30_000;

/** Exponential backoff multiplier. */
export const DEFAULT_POLL_MULTIPLIER = 2;

/** Number of messages to fetch per poll cycle. */
export const DEFAULT_INBOX_PAGE_LIMIT = 50;

/** Default tool name prefix. */
export const DEFAULT_PREFIX = "ipc" as const;

/** All IPC operation names. */
export const OPERATIONS = ["send", "list"] as const;

export type IpcOperation = (typeof OPERATIONS)[number];

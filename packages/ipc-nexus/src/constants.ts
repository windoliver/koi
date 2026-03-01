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

// ---------------------------------------------------------------------------
// SSE transport defaults
// ---------------------------------------------------------------------------

/** Minimum SSE reconnection delay in milliseconds. */
export const DEFAULT_SSE_RECONNECT_MIN_MS = 1_000;

/** Maximum SSE reconnection delay in milliseconds (backoff ceiling). */
export const DEFAULT_SSE_RECONNECT_MAX_MS = 30_000;

/** Keepalive timeout: if no data for this long, assume connection dead. (3x server keepalive of 15s) */
export const DEFAULT_SSE_KEEPALIVE_TIMEOUT_MS = 45_000;

/** Default capacity for the seen-buffer ring (max ~400KB). */
export const DEFAULT_SEEN_CAPACITY = 10_000;

/** Delay before checking if SSE connected — if not, fall back to polling. */
export const DEFAULT_SSE_FALLBACK_CHECK_MS = 2_000;

/** Message delivery transport mode. */
export type DeliveryMode = "sse" | "polling";

/** Default delivery mode — SSE with polling fallback. */
export const DEFAULT_DELIVERY_MODE: DeliveryMode = "sse";

/** Default tool name prefix. */
export const DEFAULT_PREFIX = "ipc" as const;

/** All IPC operation names. */
export const OPERATIONS = ["send", "list"] as const;

export type IpcOperation = (typeof OPERATIONS)[number];

/**
 * Constants for @koi/scratchpad-nexus.
 */

/** Default Nexus base URL. */
export const DEFAULT_NEXUS_BASE_URL = "http://localhost:2026";

/** Default timeout for Nexus requests in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default tool prefix. */
export const DEFAULT_PREFIX = "scratchpad";

/** Operations exposed as agent-facing tools. */
export const OPERATIONS = ["write", "read", "list", "delete"] as const;

/** Branded operation type for compile-time safety. */
export type ScratchpadOperation = (typeof OPERATIONS)[number];

/** Maximum entries in the write buffer before forced flush. */
export const MAX_BUFFER_SIZE = 100;

/** Maximum entries in the generation cache (LRU). */
export const MAX_CACHE_SIZE = 100;

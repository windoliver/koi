/**
 * Configuration for the HTTP skill registry backend.
 */

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

/** Configuration for createSkillRegistryHttp. */
export interface RegistryHttpConfig {
  /** Base URL of the skill registry API (e.g., "https://registry.example.com/v1"). */
  readonly baseUrl: string;
  /** Auth token sent as Bearer token in Authorization header. */
  readonly authToken: string;
  /** Request timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number;
  /** Injectable fetch function for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Maximum number of entries in the LRU cache. Default: 500. */
  readonly maxCacheEntries?: number;
  /** Cache entry TTL in milliseconds. Default: 300_000 (5 minutes). */
  readonly cacheTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_CACHE_ENTRIES = 500;
export const DEFAULT_CACHE_TTL_MS = 300_000;

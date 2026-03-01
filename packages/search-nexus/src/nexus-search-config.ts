/**
 * Configuration for Nexus search REST adapter.
 */

/** Injectable fetch for testing. Defaults to global `fetch`. */
export type FetchFn = typeof fetch;

export interface NexusSearchConfig {
  /** Nexus server base URL (e.g. "http://localhost:2026") */
  readonly baseUrl: string;
  /** API key for Nexus authentication */
  readonly apiKey: string;
  /** Override the global fetch function (useful for testing) */
  readonly fetchFn?: FetchFn;
  /** Request timeout in milliseconds (default: 30_000) */
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

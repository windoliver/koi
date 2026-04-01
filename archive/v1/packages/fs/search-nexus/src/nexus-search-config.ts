/**
 * Configuration for Nexus search REST adapter.
 */

import type { RetryConfig } from "@koi/errors";

/** Injectable fetch for testing. Defaults to global `fetch`. */
export type FetchFn = typeof fetch;

export interface NexusSearchConfig {
  /** Nexus server base URL (e.g. "http://localhost:2026") */
  readonly baseUrl: string;
  /** API key for Nexus authentication */
  readonly apiKey: string;
  /** Override the global fetch function (useful for testing) */
  readonly fetchFn?: FetchFn | undefined;
  /** Request timeout in milliseconds (default: 10_000) */
  readonly timeoutMs?: number | undefined;
  /** Default result limit per query (default: 10) */
  readonly defaultLimit?: number | undefined;
  /** Default minimum score threshold 0–1 (default: 0) */
  readonly minScore?: number | undefined;
  /** Retry configuration for transient failures */
  readonly retry?: Partial<RetryConfig> | undefined;
  /** Maximum documents per index batch (default: 100) */
  readonly maxBatchSize?: number | undefined;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_LIMIT = 10;
export const DEFAULT_MIN_SCORE = 0;
export const DEFAULT_MAX_BATCH_SIZE = 100;

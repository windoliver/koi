/**
 * Call dedup types — cache store interface and cache entry types.
 */

import type { ToolResponse } from "@koi/core/middleware";

/** A cached tool response with an expiration timestamp. */
export interface CacheEntry {
  readonly response: ToolResponse;
  readonly expiresAt: number;
}

/**
 * Key-value cache store for deduplicating tool call results.
 * Implementations may be sync (in-memory) or async (network).
 */
export interface CallDedupStore {
  readonly get: (key: string) => CacheEntry | undefined | Promise<CacheEntry | undefined>;
  readonly set: (key: string, entry: CacheEntry) => void | Promise<void>;
  readonly delete: (key: string) => boolean | Promise<boolean>;
  readonly size: () => number | Promise<number>;
  readonly clear: () => void | Promise<void>;
}

/** Info passed to onCacheHit callbacks. */
export interface CacheHitInfo {
  readonly sessionId: string;
  readonly toolId: string;
  readonly cacheKey: string;
}

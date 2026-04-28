/**
 * Call dedup — cache types.
 */

import type { ToolRequest, ToolResponse } from "@koi/core";

export interface CacheEntry {
  readonly response: ToolResponse;
  readonly expiresAt: number;
}

export interface CallDedupStore {
  readonly get: (key: string) => CacheEntry | undefined | Promise<CacheEntry | undefined>;
  readonly set: (key: string, entry: CacheEntry) => void | Promise<void>;
  readonly delete: (key: string) => boolean | Promise<boolean>;
  readonly size: () => number | Promise<number>;
  readonly clear: () => void | Promise<void>;
}

export interface CacheHitInfo {
  readonly sessionId: string;
  readonly toolId: string;
  readonly cacheKey: string;
  /**
   * The request that produced the cache hit. Included so callers can
   * wire `onCacheHit` to an audit/transcript sink — dedup runs at
   * intercept phase and short-circuits before downstream observe-phase
   * middleware (audit, transcript, event-trace) gets a chance to record
   * the call. This callback is the explicit observability seam for that
   * gap.
   */
  readonly request: ToolRequest;
  /**
   * The cached response served to the caller (with `metadata.cached =
   * true` already stamped). Wire this through the same audit/transcript
   * pathway used for live tool results to keep cache hits visible.
   */
  readonly response: ToolResponse;
}

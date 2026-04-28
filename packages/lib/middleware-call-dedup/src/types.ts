/**
 * Call dedup — cache types.
 */

import type { ToolResponse } from "@koi/core";

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
}

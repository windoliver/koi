/**
 * Call dedup — cache types.
 */

import type { ToolRequest, ToolResponse } from "@koi/core";

export interface CacheEntry {
  readonly response: ToolResponse;
  readonly expiresAt: number;
  /**
   * Per-session generation captured at write time. The middleware bumps
   * its in-memory `sessionGen` on `onSessionEnd`, so a stored entry whose
   * generation no longer matches the live counter belongs to a previous
   * run of the same `sessionId`. Such orphans can outlive their session
   * if backend `delete()` failed during eviction (best-effort by
   * design); reads MUST treat a generation mismatch as a miss to prevent
   * cross-session staleness.
   *
   * Optional for back-compat with stores that already hold entries
   * written before this field existed — callers are expected to default
   * a missing generation to 0 and reject any non-zero live generation.
   */
  readonly generation?: number | undefined;
  /**
   * Runtime-instance nonce captured at middleware creation. Reads
   * MUST reject any entry whose `instance` does not match the live
   * middleware instance — otherwise a persistent store (Redis,
   * SQLite, etc.) would replay stale tool output across process
   * restarts (the in-memory `sessionGen` tombstone is empty after
   * restart, so a `generation: 0` entry written by the prior
   * instance would still match `liveGen: 0` for a reused sessionId).
   *
   * Optional for back-compat: entries written before this field
   * existed are treated as foreign-instance and rejected. To opt
   * into restart-safe persistent caching, pin
   * `CallDedupConfig.instanceNonce` to a stable value across
   * deployments.
   */
  readonly instance?: string | undefined;
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

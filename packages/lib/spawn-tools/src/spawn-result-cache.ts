/**
 * SpawnResultCache — bounded LRU + in-flight dedup for idempotent agent_spawn.
 *
 * Key shape: `${parentAgentId}::${agentName}::${taskId}::${digest}` where
 * `digest` is a hash of (agentName, description, context). Including the
 * digest means a retry with the same `task_id` but updated instructions or
 * context produces a fresh key — we never replay stale output for changed
 * work. Without `context.task_id` (or context entirely) the key is
 * `undefined` and dedup is skipped.
 *
 * `runDeduped` coordinates two layers:
 *   1. settled-result LRU — caches successful outputs across retries
 *   2. in-flight Promise map — concurrent callers with the same key share a
 *      single `spawnFn` invocation. The first caller drives the spawn; later
 *      arrivals await its Promise instead of starting their own.
 *
 * Failures are NOT cached (retryable infra errors should retry). Inflight
 * entries are cleared in `finally` so a rejection or error result frees
 * the slot for the next attempt.
 *
 * LRU is Map insertion-order: `get` promotes (delete + re-insert), `set`
 * evicts the oldest at capacity. Sync — no async overhead on the hot path.
 *
 * Cap of 256 covers realistic coordinator fan-out (issue #1709).
 */

import { computeContentHash } from "@koi/hash";

export const DEFAULT_SPAWN_CACHE_CAP = 256;

export type SpawnFactoryResult =
  | {
      readonly ok: true;
      readonly output: string;
      /**
       * Whether this result represents a completed child execution and may be
       * cached for future retries. Defaults to `true` when omitted. Set to
       * `false` for deferred / on-demand delivery modes where `spawnFn` returns
       * before the child finishes — caching a partial/empty output would mask
       * a later child failure on retry.
       */
      readonly cacheable?: boolean;
    }
  | { readonly ok: false; readonly error: string };

export type SpawnRunResult =
  | { readonly ok: true; readonly output: string; readonly deduplicated: boolean }
  | { readonly ok: false; readonly error: string };

export interface SpawnResultCache {
  readonly get: (key: string) => string | undefined;
  readonly set: (key: string, output: string) => void;
  readonly size: () => number;
  readonly runDeduped: (
    key: string,
    factory: () => Promise<SpawnFactoryResult>,
  ) => Promise<SpawnRunResult>;
}

export function createSpawnResultCache(
  maxEntries: number = DEFAULT_SPAWN_CACHE_CAP,
): SpawnResultCache {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`SpawnResultCache: maxEntries must be a positive integer, got ${maxEntries}`);
  }

  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<SpawnFactoryResult>>();

  function get(key: string): string | undefined {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function set(key: string, output: string): void {
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, output);
  }

  async function runDeduped(
    key: string,
    factory: () => Promise<SpawnFactoryResult>,
  ): Promise<SpawnRunResult> {
    const settled = get(key);
    if (settled !== undefined) {
      return { ok: true, output: settled, deduplicated: true };
    }

    const pending = inflight.get(key);
    if (pending !== undefined) {
      const shared = await pending;
      if (!shared.ok) return { ok: false, error: shared.error };
      return { ok: true, output: shared.output, deduplicated: true };
    }

    const promise = factory();
    inflight.set(key, promise);
    try {
      const result = await promise;
      if (result.ok) {
        if (result.cacheable !== false) set(key, result.output);
        return { ok: true, output: result.output, deduplicated: false };
      }
      return { ok: false, error: result.error };
    } finally {
      inflight.delete(key);
    }
  }

  return {
    get,
    set,
    size: () => cache.size,
    runDeduped,
  };
}

/**
 * Build a stable cache key from spawn identity + request body. Returns
 * `undefined` when no `context.task_id` is available — caller should skip
 * the cache in that case.
 *
 * The digest covers `agentName`, `description`, and the full `context`
 * object so retries with changed instructions produce a different key
 * (no stale-output replay).
 */
export function spawnCacheKey(
  parentAgentId: string,
  agentName: string,
  description: string,
  context: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (context === undefined) return undefined;
  const taskId = context.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) return undefined;
  const digest = computeRequestDigest(agentName, description, context);
  // Non-serializable context (BigInt, cyclic refs) can't be hashed
  // deterministically — skip the cache rather than crash the tool.
  if (digest === undefined) return undefined;
  return `${parentAgentId}::${agentName}::${taskId}::${digest}`;
}

function computeRequestDigest(
  agentName: string,
  description: string,
  context: Readonly<Record<string, unknown>>,
): string | undefined {
  // computeContentHash deterministically serializes with sorted object keys,
  // so two contexts with identical data but different key insertion order
  // produce the same digest — and therefore the same cache key.
  // Returns the first 16 hex chars; full SHA-256 is overkill for a 256-entry LRU.
  try {
    return computeContentHash({ agentName, description, context }).slice(0, 16);
  } catch {
    return undefined;
  }
}

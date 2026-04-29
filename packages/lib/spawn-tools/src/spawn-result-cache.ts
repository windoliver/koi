/**
 * SpawnResultCache — bounded LRU for idempotent agent_spawn delivery.
 *
 * Key: `${parentAgentId}::${agentName}::${taskId}` (only when context.task_id is
 * a non-empty string). Without a task_id we cannot identify the same logical
 * spawn across retries, so dedup is skipped and the spawn proceeds.
 *
 * Stores successful spawn outputs only — failures are retryable, so re-spawning
 * after an error is the correct behavior.
 *
 * Map insertion-order LRU: `get` promotes (delete + re-insert), `set` evicts
 * the oldest entry at capacity. Sync — no async overhead on the hot path.
 *
 * Cap of 256 covers realistic coordinator fan-out (issue #1709).
 */

export const DEFAULT_SPAWN_CACHE_CAP = 256;

export interface SpawnResultCache {
  readonly get: (key: string) => string | undefined;
  readonly set: (key: string, output: string) => void;
  readonly size: () => number;
}

export function createSpawnResultCache(
  maxEntries: number = DEFAULT_SPAWN_CACHE_CAP,
): SpawnResultCache {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`SpawnResultCache: maxEntries must be a positive integer, got ${maxEntries}`);
  }

  const cache = new Map<string, string>();

  return {
    get(key: string): string | undefined {
      const entry = cache.get(key);
      if (entry === undefined) return undefined;
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    },

    set(key: string, output: string): void {
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      cache.set(key, output);
    },

    size(): number {
      return cache.size;
    },
  };
}

/**
 * Build a stable cache key from spawn identity. Returns `undefined` when no
 * task_id is available — caller should skip the cache in that case.
 */
export function spawnCacheKey(
  parentAgentId: string,
  agentName: string,
  context: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (context === undefined) return undefined;
  const taskId = context["task_id"];
  if (typeof taskId !== "string" || taskId.length === 0) return undefined;
  return `${parentAgentId}::${agentName}::${taskId}`;
}

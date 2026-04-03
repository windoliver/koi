/**
 * Engine cache — reuse createKoi() instances across Activity turns.
 *
 * Decision 13A: Cache engine across turns, invalidated on manifest
 * hash + forge generation change. Avoids re-assembling ECS entity,
 * middleware chain, and component providers on every turn.
 */

import type { EngineCacheKey } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of KoiRuntime that the cache manages.
 * Uses structural typing to avoid importing the full KoiRuntime type
 * (which would require a deep engine dependency).
 */
export interface CachedRuntime {
  readonly run: (input: unknown) => AsyncIterable<unknown>;
}

/** Factory function that creates a new engine runtime. */
export type RuntimeFactory = (options: Record<string, unknown>) => Promise<CachedRuntime>;

export interface EngineCache {
  /**
   * Get or create a cached engine runtime.
   *
   * Returns the cached instance if the cache key matches.
   * Otherwise, creates a new instance and caches it.
   */
  readonly getOrCreate: (
    key: EngineCacheKey,
    options: Record<string, unknown>,
  ) => Promise<CachedRuntime>;

  /** Force invalidation of the cached instance. */
  readonly invalidate: () => void;

  /** Whether a cached instance exists. */
  readonly hasCached: () => boolean;

  /** Current cache key, or undefined if empty. */
  readonly currentKey: () => EngineCacheKey | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create an engine cache that stores a single KoiRuntime instance.
 *
 * The cache key is `manifestHash + forgeGeneration`. When either changes
 * (e.g., forge hot-reload, manifest update), the cached engine is
 * discarded and a new one is created.
 *
 * @param factory - Function that creates a new runtime (typically `createKoi`)
 */
export function createEngineCache(factory: RuntimeFactory): EngineCache {
  let cachedKey: EngineCacheKey | undefined;
  let cachedRuntime: CachedRuntime | undefined;

  function keysMatch(a: EngineCacheKey, b: EngineCacheKey): boolean {
    return a.manifestHash === b.manifestHash && a.forgeGeneration === b.forgeGeneration;
  }

  return {
    async getOrCreate(key, options) {
      if (cachedRuntime !== undefined && cachedKey !== undefined && keysMatch(cachedKey, key)) {
        return cachedRuntime;
      }

      // Create new instance — previous one is discarded (GC'd)
      const runtime = await factory(options);
      cachedKey = key;
      cachedRuntime = runtime;
      return runtime;
    },

    invalidate(): void {
      cachedKey = undefined;
      cachedRuntime = undefined;
    },

    hasCached(): boolean {
      return cachedRuntime !== undefined;
    },

    currentKey(): EngineCacheKey | undefined {
      return cachedKey;
    },
  };
}

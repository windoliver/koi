import type { Embedder } from "@koi/core";

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

export interface EmbedderCacheConfig {
  readonly embedder: Embedder;
  /** LRU eviction threshold. Default 10_000 */
  readonly maxSize?: number;
}

export type CachedEmbedder = Embedder & { readonly stats: CacheStats };

/**
 * Wraps an Embedder with an in-memory LRU cache.
 * Embeddings are deterministic per model, so text identity is the cache key.
 */
export function createCachedEmbedder(config: EmbedderCacheConfig): CachedEmbedder {
  const { embedder } = config;
  const maxSize = config.maxSize ?? 10_000;
  const cache = new Map<string, readonly number[]>();
  let hits = 0;
  let misses = 0;

  function evictIfNeeded(): void {
    while (cache.size >= maxSize) {
      // Map iterates in insertion order — first key is the oldest (LRU)
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
  }

  /** Move key to end of insertion order (most-recently-used). */
  function touch(key: string, value: readonly number[]): void {
    cache.delete(key);
    cache.set(key, value);
  }

  async function embed(text: string): Promise<readonly number[]> {
    const cached = cache.get(text);
    if (cached !== undefined) {
      hits++;
      touch(text, cached);
      return cached;
    }

    misses++;
    const result = await embedder.embed(text);
    evictIfNeeded();
    cache.set(text, result);
    return result;
  }

  async function embedMany(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const results: (readonly number[] | undefined)[] = new Array(texts.length);
    const missIndices: number[] = [];
    const missTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (text === undefined) continue;
      const cached = cache.get(text);
      if (cached !== undefined) {
        hits++;
        touch(text, cached);
        results[i] = cached;
      } else {
        misses++;
        missIndices.push(i);
        missTexts.push(text);
      }
    }

    if (missTexts.length > 0) {
      const computed = await embedder.embedMany(missTexts);
      for (let j = 0; j < missIndices.length; j++) {
        const idx = missIndices[j];
        const embedding = computed[j];
        const text = missTexts[j];
        if (idx === undefined || embedding === undefined || text === undefined) continue;
        results[idx] = embedding;
        evictIfNeeded();
        cache.set(text, embedding);
      }
    }

    return results as readonly (readonly number[])[];
  }

  return {
    embed,
    embedMany,
    dimensions: embedder.dimensions,
    get stats(): CacheStats {
      return { hits, misses, size: cache.size };
    },
  };
}

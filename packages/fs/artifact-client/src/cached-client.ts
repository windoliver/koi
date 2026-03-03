/**
 * Cached ArtifactClient — LRU cache wrapper with dual-limit eviction.
 *
 * Wraps any ArtifactClient with an in-memory LRU cache:
 * - load() / exists() check cache first
 * - save() / update() / remove() delegate then invalidate
 * - search() always delegates (results are query-dependent)
 */

import type { KoiError, Result } from "@koi/core";
import type { ArtifactClient } from "./client.js";
import type { Artifact, ArtifactId, ArtifactPage, ArtifactQuery, ArtifactUpdate } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CacheOptions {
  /** Maximum number of cached entries. Default: 1000. */
  readonly maxEntries?: number | undefined;
  /** Maximum total cache size in bytes. Default: 50MB. */
  readonly maxSizeBytes?: number | undefined;
  /** Time-to-live in milliseconds. Default: 300_000 (5 min). */
  readonly ttlMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// LRU doubly-linked list + Map
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly artifact: Artifact;
  readonly sizeBytes: number;
  readonly insertedAt: number;
  prev: string | undefined;
  next: string | undefined;
}

interface LruCache {
  readonly entries: Map<string, CacheEntry>;
  head: string | undefined; // most recently used
  tail: string | undefined; // least recently used
  totalSizeBytes: number;
}

function createLruCache(): LruCache {
  return { entries: new Map(), head: undefined, tail: undefined, totalSizeBytes: 0 };
}

function detach(cache: LruCache, _key: string, entry: CacheEntry): void {
  if (entry.prev !== undefined) {
    const prevEntry = cache.entries.get(entry.prev);
    if (prevEntry) prevEntry.next = entry.next;
  } else {
    cache.head = entry.next;
  }

  if (entry.next !== undefined) {
    const nextEntry = cache.entries.get(entry.next);
    if (nextEntry) nextEntry.prev = entry.prev;
  } else {
    cache.tail = entry.prev;
  }

  entry.prev = undefined;
  entry.next = undefined;
}

function pushToHead(cache: LruCache, key: string, entry: CacheEntry): void {
  entry.prev = undefined;
  entry.next = cache.head;

  if (cache.head !== undefined) {
    const headEntry = cache.entries.get(cache.head);
    if (headEntry) headEntry.prev = key;
  }

  cache.head = key;
  if (cache.tail === undefined) {
    cache.tail = key;
  }
}

function evictLru(cache: LruCache): void {
  if (cache.tail === undefined) return;

  const tailKey = cache.tail;
  const tailEntry = cache.entries.get(tailKey);
  if (tailEntry === undefined) return;

  detach(cache, tailKey, tailEntry);
  cache.totalSizeBytes -= tailEntry.sizeBytes;
  cache.entries.delete(tailKey);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TTL_MS = 300_000; // 5 minutes

export function createCachedArtifactClient(
  inner: ArtifactClient,
  options?: CacheOptions,
): ArtifactClient {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;

  const cache = createLruCache();

  function isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.insertedAt > ttlMs;
  }

  function cacheGet(key: string): Artifact | undefined {
    const entry = cache.entries.get(key);
    if (entry === undefined) return undefined;

    if (isExpired(entry)) {
      detach(cache, key, entry);
      cache.totalSizeBytes -= entry.sizeBytes;
      cache.entries.delete(key);
      return undefined;
    }

    // Move to head (most recently used)
    detach(cache, key, entry);
    pushToHead(cache, key, entry);
    return entry.artifact;
  }

  function cachePut(key: string, artifact: Artifact): void {
    // Remove existing entry if present
    const existing = cache.entries.get(key);
    if (existing !== undefined) {
      detach(cache, key, existing);
      cache.totalSizeBytes -= existing.sizeBytes;
      cache.entries.delete(key);
    }

    const sizeBytes = artifact.sizeBytes;

    // Evict until within limits
    while (cache.entries.size >= maxEntries && cache.tail !== undefined) {
      evictLru(cache);
    }
    while (cache.totalSizeBytes + sizeBytes > maxSizeBytes && cache.tail !== undefined) {
      evictLru(cache);
    }

    const entry: CacheEntry = {
      artifact,
      sizeBytes,
      insertedAt: Date.now(),
      prev: undefined,
      next: undefined,
    };
    cache.entries.set(key, entry);
    cache.totalSizeBytes += sizeBytes;
    pushToHead(cache, key, entry);
  }

  function cacheRemove(key: string): void {
    const entry = cache.entries.get(key);
    if (entry === undefined) return;
    detach(cache, key, entry);
    cache.totalSizeBytes -= entry.sizeBytes;
    cache.entries.delete(key);
  }

  // -----------------------------------------------------------------------
  // ArtifactClient methods
  // -----------------------------------------------------------------------

  const save = async (artifact: Artifact): Promise<Result<void, KoiError>> => {
    const result = await inner.save(artifact);
    if (result.ok) {
      cachePut(artifact.id, artifact);
    }
    return result;
  };

  const load = async (id: ArtifactId): Promise<Result<Artifact, KoiError>> => {
    const cached = cacheGet(id);
    if (cached !== undefined) {
      return { ok: true, value: cached };
    }

    const result = await inner.load(id);
    if (result.ok) {
      cachePut(id, result.value);
    }
    return result;
  };

  const search = async (query: ArtifactQuery): Promise<Result<ArtifactPage, KoiError>> => {
    // Search always delegates — results are query-dependent
    return inner.search(query);
  };

  const remove = async (id: ArtifactId): Promise<Result<void, KoiError>> => {
    const result = await inner.remove(id);
    if (result.ok) {
      cacheRemove(id);
    }
    return result;
  };

  const update = async (
    id: ArtifactId,
    updates: ArtifactUpdate,
  ): Promise<Result<void, KoiError>> => {
    const result = await inner.update(id, updates);
    if (result.ok) {
      // Invalidate — next load will re-fetch
      cacheRemove(id);
    }
    return result;
  };

  const exists = async (id: ArtifactId): Promise<Result<boolean, KoiError>> => {
    const cached = cacheGet(id);
    if (cached !== undefined) {
      return { ok: true, value: true };
    }
    return inner.exists(id);
  };

  return { save, load, search, remove, update, exists };
}

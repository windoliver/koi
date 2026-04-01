/**
 * ProcFs implementation — path-based virtual filesystem with TTL microcache.
 *
 * L2 package: imports only from @koi/core.
 */

import type { ProcEntry, ProcFs, WritableProcEntry } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProcFsConfig {
  /** TTL for cached read values in milliseconds. Default: 1000ms. */
  readonly cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 1000;

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly value: unknown;
  readonly expiry: number;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isWritable(entry: ProcEntry | WritableProcEntry): entry is WritableProcEntry {
  return "write" in entry;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProcFs(config?: ProcFsConfig): ProcFs {
  const ttlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const entries = new Map<string, ProcEntry | WritableProcEntry>();
  const cache = new Map<string, CacheEntry>();

  function mount(path: string, entry: ProcEntry | WritableProcEntry): void {
    entries.set(path, entry);
    // Invalidate cache when mount changes
    cache.delete(path);
  }

  function unmount(path: string): void {
    entries.delete(path);
    cache.delete(path);
  }

  async function read(path: string): Promise<unknown> {
    const entry = entries.get(path);
    if (entry === undefined) return undefined;

    // Check cache
    const cached = cache.get(path);
    const now = Date.now();
    if (cached !== undefined && now < cached.expiry) {
      return cached.value;
    }

    // Read fresh value
    const value = await entry.read();
    cache.set(path, { value, expiry: now + ttlMs });
    return value;
  }

  async function write(path: string, value: unknown): Promise<void> {
    const entry = entries.get(path);
    if (entry === undefined) {
      throw new Error(`ProcFs: path "${path}" not found`);
    }
    if (!isWritable(entry)) {
      throw new Error(`ProcFs: path "${path}" is read-only`);
    }
    await entry.write(value);
    // Invalidate cache on write
    cache.delete(path);
  }

  async function list(path: string): Promise<readonly string[]> {
    const entry = entries.get(path);
    if (entry?.list !== undefined) {
      return entry.list();
    }

    // Fall back to prefix matching for directory-like paths
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const children: string[] = [];
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) {
        // Get the next path segment after the prefix
        const remainder = key.slice(prefix.length);
        const segment = remainder.split("/")[0];
        if (segment !== undefined && !children.includes(segment)) {
          children.push(segment);
        }
      }
    }
    return children;
  }

  function allEntries(): readonly string[] {
    return [...entries.keys()];
  }

  /** Invalidate a specific cache entry. */
  function invalidate(path: string): void {
    cache.delete(path);
  }

  return {
    mount,
    unmount,
    read,
    write,
    list,
    entries: allEntries,
    /** Non-contract extension: invalidate cache for a path. */
    invalidate,
  } as ProcFs & { readonly invalidate: (path: string) => void };
}

/**
 * In-memory SurfaceStore with LRU eviction.
 *
 * Surfaces are opaque blobs — store does not interpret content. Default
 * implementation; production deployments may swap in a durable backend by
 * implementing the {@link SurfaceStore} interface.
 */

import { conflict, notFound } from "@koi/core";
import { computeStringHash } from "@koi/hash";

import type { SurfaceEntry, SurfaceStore, SurfaceStoreConfig } from "./types.js";

const DEFAULT_SURFACE_STORE_CONFIG: SurfaceStoreConfig = {
  maxSurfaces: 10_000,
} as const;

export function createInMemorySurfaceStore(
  configOverrides?: Partial<SurfaceStoreConfig>,
): SurfaceStore {
  const config: SurfaceStoreConfig = { ...DEFAULT_SURFACE_STORE_CONFIG, ...configOverrides };
  const map = new Map<string, SurfaceEntry>();
  // let: monotonic counter for LRU ordering — Date.now() can repeat within same ms
  let accessCounter = 0;
  const accessOrder = new Map<string, number>();

  function touchAccess(id: string): void {
    accessCounter += 1;
    accessOrder.set(id, accessCounter);
  }

  function evictLru(): void {
    if (map.size < config.maxSurfaces) return;

    // let: track lowest access order while iterating
    let oldestKey: string | undefined;
    let oldestOrder = Number.POSITIVE_INFINITY;
    for (const [key] of map) {
      const order = accessOrder.get(key) ?? 0;
      if (order < oldestOrder) {
        oldestOrder = order;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
      accessOrder.delete(oldestKey);
    }
  }

  return {
    get(id) {
      const entry = map.get(id);
      if (entry === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      const accessed: SurfaceEntry = { ...entry, lastAccessedAt: Date.now() };
      map.set(id, accessed);
      touchAccess(id);
      return { ok: true, value: accessed };
    },

    create(id, content, metadata) {
      if (map.has(id)) {
        return { ok: false, error: conflict(id, `Surface already exists: ${id}`) };
      }
      evictLru();
      const now = Date.now();
      const entry: SurfaceEntry = {
        surfaceId: id,
        content,
        contentHash: computeStringHash(content),
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        ...(metadata !== undefined ? { metadata } : {}),
      };
      map.set(id, entry);
      touchAccess(id);
      return { ok: true, value: entry };
    },

    update(id, content, expectedHash) {
      const existing = map.get(id);
      if (existing === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      if (expectedHash !== undefined && expectedHash !== existing.contentHash) {
        return {
          ok: false,
          error: conflict(
            id,
            `Content hash mismatch: expected ${expectedHash}, got ${existing.contentHash}`,
          ),
        };
      }
      const now = Date.now();
      const contentHash =
        content === existing.content ? existing.contentHash : computeStringHash(content);
      const updated: SurfaceEntry = {
        ...existing,
        content,
        contentHash,
        updatedAt: now,
        lastAccessedAt: now,
      };
      map.set(id, updated);
      touchAccess(id);
      return { ok: true, value: updated };
    },

    delete(id) {
      accessOrder.delete(id);
      return { ok: true, value: map.delete(id) };
    },

    has(id) {
      return { ok: true, value: map.has(id) };
    },

    size(): number {
      return map.size;
    },
  };
}

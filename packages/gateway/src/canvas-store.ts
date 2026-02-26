/**
 * SurfaceStore: pluggable surface persistence for canvas rendering.
 *
 * Surfaces are opaque blobs — the store does not understand A2UI structure.
 * Default in-memory implementation with LRU eviction provided.
 */

import type { KoiError, Result } from "@koi/core";
import { conflict, notFound } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SurfaceEntry {
  readonly surfaceId: string;
  /** Opaque serialized surface content. */
  readonly content: string;
  /** SHA-256 hex digest of content — used as ETag. */
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Tracks access time for LRU eviction. */
  readonly lastAccessedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SurfaceStore {
  readonly get: (
    id: string,
  ) => Result<SurfaceEntry, KoiError> | Promise<Result<SurfaceEntry, KoiError>>;
  readonly create: (
    id: string,
    content: string,
    metadata?: Readonly<Record<string, unknown>>,
  ) => Result<SurfaceEntry, KoiError> | Promise<Result<SurfaceEntry, KoiError>>;
  /**
   * Update surface content.
   * If expectedHash is provided and doesn't match current hash → CONFLICT error (CAS).
   * If expectedHash is undefined → unconditional update.
   */
  readonly update: (
    id: string,
    content: string,
    expectedHash: string | undefined,
  ) => Result<SurfaceEntry, KoiError> | Promise<Result<SurfaceEntry, KoiError>>;
  readonly delete: (id: string) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  readonly has: (id: string) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  readonly size: () => number;
}

export interface SurfaceStoreConfig {
  /** Maximum number of surfaces before LRU eviction. Default: 10_000. */
  readonly maxSurfaces: number;
}

const DEFAULT_SURFACE_STORE_CONFIG: SurfaceStoreConfig = {
  maxSurfaces: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of content using Bun native crypto. */
export function computeContentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory implementation with LRU eviction
// ---------------------------------------------------------------------------

export function createInMemorySurfaceStore(
  configOverrides?: Partial<SurfaceStoreConfig>,
): SurfaceStore {
  const config: SurfaceStoreConfig = { ...DEFAULT_SURFACE_STORE_CONFIG, ...configOverrides };
  const map = new Map<string, SurfaceEntry>();
  // Monotonic counter for LRU ordering (Date.now() can repeat within same ms)
  let accessCounter = 0;
  const accessOrder = new Map<string, number>();

  function touchAccess(id: string): void {
    accessOrder.set(id, ++accessCounter);
  }

  function evictLru(): void {
    if (map.size < config.maxSurfaces) return;

    let oldestKey: string | undefined;
    let oldestOrder = Infinity;
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
    get(id: string): Result<SurfaceEntry, KoiError> {
      const entry = map.get(id);
      if (entry === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      // Update lastAccessedAt for LRU tracking (new object, not mutation)
      const accessed: SurfaceEntry = { ...entry, lastAccessedAt: Date.now() };
      map.set(id, accessed);
      touchAccess(id);
      return { ok: true, value: accessed };
    },

    create(
      id: string,
      content: string,
      metadata?: Readonly<Record<string, unknown>>,
    ): Result<SurfaceEntry, KoiError> {
      if (map.has(id)) {
        return { ok: false, error: conflict(id, `Surface already exists: ${id}`) };
      }
      evictLru();
      const now = Date.now();
      const entry: SurfaceEntry = {
        surfaceId: id,
        content,
        contentHash: computeContentHash(content),
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        ...(metadata !== undefined ? { metadata } : {}),
      };
      map.set(id, entry);
      touchAccess(id);
      return { ok: true, value: entry };
    },

    update(
      id: string,
      content: string,
      expectedHash: string | undefined,
    ): Result<SurfaceEntry, KoiError> {
      const existing = map.get(id);
      if (existing === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      // CAS check: if expectedHash provided, must match current
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
      const updated: SurfaceEntry = {
        ...existing,
        content,
        contentHash: computeContentHash(content),
        updatedAt: now,
        lastAccessedAt: now,
      };
      map.set(id, updated);
      touchAccess(id);
      return { ok: true, value: updated };
    },

    delete(id: string): Result<boolean, KoiError> {
      accessOrder.delete(id);
      return { ok: true, value: map.delete(id) };
    },

    has(id: string): Result<boolean, KoiError> {
      return { ok: true, value: map.has(id) };
    },

    size(): number {
      return map.size;
    },
  };
}

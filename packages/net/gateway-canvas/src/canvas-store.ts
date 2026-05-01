/**
 * In-memory SurfaceStore.
 *
 * Surfaces are opaque blobs — store does not interpret content. Default
 * implementation; production deployments may swap in a durable backend by
 * implementing the {@link SurfaceStore} interface.
 *
 * Capacity behavior: when `maxSurfaces` is reached, `create()` returns
 * `RESOURCE_EXHAUSTED` instead of silently evicting an unrelated surface.
 * Silent LRU eviction was rejected because it produces invisible data loss
 * (subscribers never see the deletion, callers never see the discard).
 */

import type { KoiError } from "@koi/core";
import { conflict, notFound, permission } from "@koi/core";
import { computeStringHash } from "@koi/hash";

import type { SurfaceEntry, SurfaceStore, SurfaceStoreConfig } from "./types.js";

const DEFAULT_SURFACE_STORE_CONFIG: SurfaceStoreConfig = {
  maxSurfaces: 10_000,
} as const;

function resourceExhausted(message: string): KoiError {
  return { code: "RESOURCE_EXHAUSTED", message, retryable: true };
}

export function createInMemorySurfaceStore(
  configOverrides?: Partial<SurfaceStoreConfig>,
): SurfaceStore {
  const config: SurfaceStoreConfig = { ...DEFAULT_SURFACE_STORE_CONFIG, ...configOverrides };
  const map = new Map<string, SurfaceEntry>();
  // let: monotonic per-store generation counter; bumped on every create
  let generationCounter = 0;

  return {
    get(id) {
      const entry = map.get(id);
      if (entry === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      const accessed: SurfaceEntry = { ...entry, lastAccessedAt: Date.now() };
      map.set(id, accessed);
      return { ok: true, value: accessed };
    },

    create(id, content, options) {
      if (map.has(id)) {
        return { ok: false, error: conflict(id, `Surface already exists: ${id}`) };
      }
      if (map.size >= config.maxSurfaces) {
        return {
          ok: false,
          error: resourceExhausted(
            `Surface store is full (${config.maxSurfaces}); delete a surface or raise maxSurfaces`,
          ),
        };
      }
      const now = Date.now();
      generationCounter += 1;
      const entry: SurfaceEntry = {
        surfaceId: id,
        content,
        contentHash: computeStringHash(content),
        generationId: generationCounter,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        ...(options?.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
        ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
      };
      map.set(id, entry);
      return { ok: true, value: entry };
    },

    update(id, content, expectedHash, expectedOwnerId) {
      const existing = map.get(id);
      if (existing === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      // Atomic ownership check: when an owner is specified, the surface must
      // be owned by that agent. Atomic with the hash precondition below — no
      // TOCTOU window between owner-check and mutation.
      if (expectedOwnerId !== undefined && existing.ownerId !== expectedOwnerId) {
        return { ok: false, error: permission(`Not the owner of surface: ${id}`) };
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
      return { ok: true, value: updated };
    },

    delete(id, expectedOwnerId) {
      const existing = map.get(id);
      // Owner-aware delete: atomic check + remove; missing entry returns false
      // (idempotent). Owner mismatch returns PERMISSION (mapped to 404 by routes).
      if (
        expectedOwnerId !== undefined &&
        existing !== undefined &&
        existing.ownerId !== expectedOwnerId
      ) {
        return { ok: false, error: permission(`Not the owner of surface: ${id}`) };
      }
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

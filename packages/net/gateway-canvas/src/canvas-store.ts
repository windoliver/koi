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

/**
 * The precondition token used by If-Match. Combines generationId with the
 * content hash so that a delete-then-recreate with identical content still
 * produces a fresh token — stale PATCH/DELETE retries cannot impersonate a
 * fence against a different surface generation.
 */
export function surfaceEtag(entry: {
  readonly generationId: number;
  readonly contentHash: string;
}): string {
  return `${entry.generationId}-${entry.contentHash}`;
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
      const existing = map.get(id);
      if (existing !== undefined) {
        // Atomic classification: cross-owner collision returns PERMISSION
        // (route → 404, no existence leak); self-collision returns CONFLICT
        // (route → 409). No follow-up `get()` needed.
        if (options?.ownerId !== undefined && existing.ownerId !== options.ownerId) {
          return { ok: false, error: permission(`Surface owned by another agent: ${id}`) };
        }
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
      const contentHash = computeStringHash(content);
      const entry: SurfaceEntry = {
        surfaceId: id,
        content,
        contentHash,
        etag: `${generationCounter}-${contentHash}`,
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

    update(id, content, expectedEtag, expectedOwnerId) {
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
      if (expectedEtag !== undefined && expectedEtag !== surfaceEtag(existing)) {
        return {
          ok: false,
          error: conflict(
            id,
            `Precondition token mismatch: expected ${expectedEtag}, got ${surfaceEtag(existing)}`,
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
        etag: `${existing.generationId}-${contentHash}`,
        updatedAt: now,
        lastAccessedAt: now,
      };
      map.set(id, updated);
      return { ok: true, value: updated };
    },

    delete(id, expectedOwnerId, expectedEtag) {
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
      // Generation fence: the supplied token must match `surfaceEtag()` of
      // the current entry — i.e. include both `generationId` and content
      // hash. A delete + recreate with identical content produces a fresh
      // generation, so stale tokens cannot impersonate the new instance.
      if (
        expectedEtag !== undefined &&
        existing !== undefined &&
        expectedEtag !== surfaceEtag(existing)
      ) {
        return {
          ok: false,
          error: conflict(
            id,
            `Precondition token mismatch: expected ${expectedEtag}, got ${surfaceEtag(existing)}`,
          ),
        };
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

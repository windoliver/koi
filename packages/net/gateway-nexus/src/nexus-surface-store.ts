/**
 * Nexus-backed SurfaceStore with lazy content fetch.
 *
 * Full content stored in Nexus. Metadata-only polling with lazy
 * content refresh on cache miss or stale hash.
 */

import type { KoiError, Result } from "@koi/core";
import { conflict, notFound } from "@koi/core";
import type { SurfaceEntry, SurfaceStore, SurfaceStoreConfig } from "@koi/gateway-types";
import type { NexusClient } from "@koi/nexus-client";
import { deleteJson, gatewaySurfacePath, readJson } from "@koi/nexus-client";
import type { DegradationConfig, GatewayNexusConfig } from "./config.js";
import { DEFAULT_DEGRADATION_CONFIG } from "./config.js";
import type { DegradationState } from "./degradation.js";
import { createDegradationState, recordFailure, recordSuccess } from "./degradation.js";
import type { WriteQueue } from "./write-queue.js";
import { createWriteQueue } from "./write-queue.js";

// ---------------------------------------------------------------------------
// Content hashing (uses Bun native crypto)
// ---------------------------------------------------------------------------

function computeContentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface NexusSurfaceStoreOptions {
  readonly client: NexusClient;
  readonly config: GatewayNexusConfig;
  readonly storeConfig?: Partial<SurfaceStoreConfig> | undefined;
}

export interface NexusSurfaceStoreHandle {
  readonly store: SurfaceStore;
  readonly degradation: () => DegradationState;
  readonly dispose: () => Promise<void>;
}

const DEFAULT_MAX_SURFACES = 10_000;

export function createNexusSurfaceStore(
  options: NexusSurfaceStoreOptions,
): NexusSurfaceStoreHandle {
  const { client, config } = options;
  const degradationConfig: DegradationConfig = {
    ...DEFAULT_DEGRADATION_CONFIG,
    ...config.degradation,
  };
  const maxSurfaces = options.storeConfig?.maxSurfaces ?? DEFAULT_MAX_SURFACES;
  const cache = new Map<string, SurfaceEntry>();
  let degradation = createDegradationState();

  // Monotonic counter for LRU ordering
  let accessCounter = 0;
  const accessOrder = new Map<string, number>();

  function touchAccess(id: string): void {
    accessOrder.set(id, ++accessCounter);
  }

  function evictLru(): void {
    if (cache.size < maxSurfaces) return;
    let oldestKey: string | undefined;
    let oldestOrder = Infinity;
    for (const [key] of cache) {
      const order = accessOrder.get(key) ?? 0;
      if (order < oldestOrder) {
        oldestOrder = order;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
      accessOrder.delete(oldestKey);
    }
  }

  const writeFn = async (path: string, data: string): Promise<void> => {
    const r = await client.rpc<null>("write", { path, content: data });
    if (r.ok) {
      degradation = recordSuccess(degradation);
    } else {
      degradation = recordFailure(degradation, degradationConfig);
    }
  };

  const queue: WriteQueue = createWriteQueue(writeFn, config.writeQueue);

  function nexusPath(id: string): string {
    return gatewaySurfacePath(id);
  }

  function enqueueEntry(entry: SurfaceEntry, immediate: boolean): void {
    queue.enqueue(nexusPath(entry.surfaceId), JSON.stringify(entry), immediate);
  }

  const store: SurfaceStore = {
    get(id: string): Result<SurfaceEntry, KoiError> | Promise<Result<SurfaceEntry, KoiError>> {
      const cached = cache.get(id);
      if (cached !== undefined) {
        const accessed: SurfaceEntry = { ...cached, lastAccessedAt: Date.now() };
        cache.set(id, accessed);
        touchAccess(id);
        return { ok: true, value: accessed };
      }
      // Cache miss — try Nexus
      if (degradation.mode === "degraded") {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      return (async (): Promise<Result<SurfaceEntry, KoiError>> => {
        const r = await readJson<SurfaceEntry>(client, nexusPath(id));
        if (r.ok) {
          degradation = recordSuccess(degradation);
          const accessed: SurfaceEntry = { ...r.value, lastAccessedAt: Date.now() };
          cache.set(id, accessed);
          touchAccess(id);
          return { ok: true, value: accessed };
        }
        if (r.error.code === "NOT_FOUND") {
          return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
        }
        degradation = recordFailure(degradation, degradationConfig);
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      })();
    },

    create(
      id: string,
      content: string,
      metadata?: Readonly<Record<string, unknown>>,
    ): Result<SurfaceEntry, KoiError> {
      if (cache.has(id)) {
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
      cache.set(id, entry);
      touchAccess(id);
      enqueueEntry(entry, true);
      return { ok: true, value: entry };
    },

    update(
      id: string,
      content: string,
      expectedHash: string | undefined,
    ): Result<SurfaceEntry, KoiError> {
      const existing = cache.get(id);
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
      const updated: SurfaceEntry = {
        ...existing,
        content,
        contentHash: computeContentHash(content),
        updatedAt: now,
        lastAccessedAt: now,
      };
      cache.set(id, updated);
      touchAccess(id);
      enqueueEntry(updated, false);
      return { ok: true, value: updated };
    },

    delete(id: string): Result<boolean, KoiError> {
      const existed = cache.delete(id);
      accessOrder.delete(id);
      // Immediate Nexus delete
      void deleteJson(client, nexusPath(id))
        .then((r) => {
          if (r.ok) {
            degradation = recordSuccess(degradation);
          } else {
            degradation = recordFailure(degradation, degradationConfig);
          }
        })
        .catch((_e: unknown) => {
          degradation = recordFailure(degradation, degradationConfig);
        });
      return { ok: true, value: existed };
    },

    has(id: string): Result<boolean, KoiError> {
      return { ok: true, value: cache.has(id) };
    },

    size(): number {
      return cache.size;
    },
  };

  return {
    store,
    degradation: () => degradation,
    dispose: () => queue.dispose(),
  };
}

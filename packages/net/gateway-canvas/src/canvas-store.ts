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

import type { KoiError, Result } from "@koi/core";
import { conflict, notFound, permission } from "@koi/core";
import { computeStringHash } from "@koi/hash";

import type { SurfaceEntry, SurfaceStore, SurfaceStoreConfig } from "./types.js";

interface SurfaceCreateOptions {
  readonly ownerId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const DEFAULT_SURFACE_STORE_CONFIG: SurfaceStoreConfig = {
  maxSurfaces: 10_000,
  maxSurfacesPerTenant: 1_000,
} as const;

function resourceExhausted(message: string): KoiError {
  return { code: "RESOURCE_EXHAUSTED", message, retryable: true };
}

/**
 * The precondition token used by If-Match. Combines per-store-instance epoch,
 * generation, version, and content hash so delete-recreate (fresh generation),
 * any update incl. no-op (fresh version), and process restart (fresh epoch)
 * all reject stale PATCH/DELETE retries.
 */
export function surfaceEtag(entry: {
  readonly instanceEpoch: string;
  readonly generationId: number;
  readonly version: number;
  readonly contentHash: string;
}): string {
  return `${entry.instanceEpoch}-${entry.generationId}-${entry.version}-${entry.contentHash}`;
}

/**
 * Defensive clone for entries returned to callers. The store must NEVER hand
 * out a live reference to its internal map value — caller mutation would
 * corrupt CAS/ownership invariants. Metadata is deep-cloned so nested object
 * mutation cannot bypass `version`/`etag` bumps.
 */
function snapshotEntry(entry: SurfaceEntry): SurfaceEntry {
  return Object.freeze({
    ...entry,
    ...(entry.metadata !== undefined ? { metadata: structuredClone(entry.metadata) } : {}),
  });
}

/**
 * `undefined` (no owner) and `""` (empty-string owner) MUST encode to distinct
 * keys. Without the leading discriminator byte, an authenticator that returns
 * `agentId: ""` would alias the ownerless namespace and let a "blank" tenant
 * read/mutate orphaned rows.
 */
function keyOf(id: string, ownerId: string | undefined): string {
  const tenant = ownerId === undefined ? "\x01" : `\x02${ownerId}`;
  return `${tenant}\x00${id}`;
}

function tenantOf(ownerId: string | undefined): string {
  return ownerId === undefined ? "\x01" : `\x02${ownerId}`;
}

interface StoreState {
  readonly config: SurfaceStoreConfig;
  readonly map: Map<string, SurfaceEntry>;
  readonly perTenantCount: Map<string, number>;
  readonly instanceEpoch: string;
  generationCounter: number;
}

function storeGet(
  state: StoreState,
  id: string,
  ownerId: string | undefined,
): Result<SurfaceEntry> {
  const entry = state.map.get(keyOf(id, ownerId));
  if (entry === undefined) {
    return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
  }
  const accessed: SurfaceEntry = { ...entry, lastAccessedAt: Date.now() };
  state.map.set(keyOf(id, ownerId), accessed);
  return { ok: true, value: snapshotEntry(accessed) };
}

function storeCreate(
  state: StoreState,
  id: string,
  content: string,
  options: SurfaceCreateOptions | undefined,
): Result<SurfaceEntry> {
  const ownerId = options?.ownerId;
  const key = keyOf(id, ownerId);
  if (state.map.get(key) !== undefined) {
    return { ok: false, error: conflict(id, `Surface already exists: ${id}`) };
  }
  const tenant = tenantOf(ownerId);
  const tenantCount = state.perTenantCount.get(tenant) ?? 0;
  if (tenantCount >= state.config.maxSurfacesPerTenant) {
    return {
      ok: false,
      error: resourceExhausted(
        `Per-tenant surface quota reached (${state.config.maxSurfacesPerTenant}); delete a surface or raise maxSurfacesPerTenant`,
      ),
    };
  }
  if (state.map.size >= state.config.maxSurfaces) {
    return {
      ok: false,
      error: resourceExhausted(
        `Surface store is full (${state.config.maxSurfaces}); delete a surface or raise maxSurfaces`,
      ),
    };
  }
  const now = Date.now();
  state.generationCounter += 1;
  const contentHash = computeStringHash(content);
  const entry: SurfaceEntry = {
    surfaceId: id,
    content,
    contentHash,
    version: 1,
    etag: `${state.instanceEpoch}-${state.generationCounter}-1-${contentHash}`,
    generationId: state.generationCounter,
    instanceEpoch: state.instanceEpoch,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    ...(options?.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
    ...(options?.metadata !== undefined ? { metadata: structuredClone(options.metadata) } : {}),
  };
  state.map.set(key, entry);
  state.perTenantCount.set(tenant, tenantCount + 1);
  return { ok: true, value: snapshotEntry(entry) };
}

function storeUpdate(
  state: StoreState,
  id: string,
  content: string,
  expectedEtag: string | undefined,
  expectedOwnerId: string | undefined,
): Result<SurfaceEntry> {
  const key = keyOf(id, expectedOwnerId);
  const existing = state.map.get(key);
  if (existing === undefined) {
    return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
  }
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
  // Bump `version` on every successful update — including no-op updates.
  // Without this, a no-op PATCH would not advance the etag, leaving older
  // If-Match tokens valid against later writes/deletes.
  const version = existing.version + 1;
  const updated: SurfaceEntry = {
    ...existing,
    content,
    contentHash,
    version,
    etag: `${existing.instanceEpoch}-${existing.generationId}-${version}-${contentHash}`,
    updatedAt: now,
    lastAccessedAt: now,
  };
  state.map.set(key, updated);
  return { ok: true, value: snapshotEntry(updated) };
}

function storeDelete(
  state: StoreState,
  id: string,
  expectedOwnerId: string | undefined,
  expectedEtag: string | undefined,
): Result<boolean> {
  const key = keyOf(id, expectedOwnerId);
  const existing = state.map.get(key);
  if (
    expectedOwnerId !== undefined &&
    existing !== undefined &&
    existing.ownerId !== expectedOwnerId
  ) {
    return { ok: false, error: permission(`Not the owner of surface: ${id}`) };
  }
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
  const removed = state.map.delete(key);
  if (removed) {
    const tenant = tenantOf(expectedOwnerId);
    const count = state.perTenantCount.get(tenant) ?? 0;
    if (count <= 1) state.perTenantCount.delete(tenant);
    else state.perTenantCount.set(tenant, count - 1);
  }
  return { ok: true, value: removed };
}

export function createInMemorySurfaceStore(
  configOverrides?: Partial<SurfaceStoreConfig>,
): SurfaceStore {
  const config: SurfaceStoreConfig = { ...DEFAULT_SURFACE_STORE_CONFIG, ...configOverrides };
  const state: StoreState = {
    config,
    map: new Map(),
    perTenantCount: new Map(),
    // 128 bits of randomness — collision probability is negligible.
    instanceEpoch: computeStringHash(`${Date.now()}-${Math.random()}-${Math.random()}`).slice(
      0,
      16,
    ),
    generationCounter: 0,
  };
  return {
    get: (id, ownerId) => storeGet(state, id, ownerId),
    create: (id, content, options) => storeCreate(state, id, content, options),
    update: (id, content, expectedEtag, expectedOwnerId) =>
      storeUpdate(state, id, content, expectedEtag, expectedOwnerId),
    delete: (id, expectedOwnerId, expectedEtag) =>
      storeDelete(state, id, expectedOwnerId, expectedEtag),
    has: (id, ownerId) => ({ ok: true, value: state.map.has(keyOf(id, ownerId)) }),
    size: () => state.map.size,
  };
}

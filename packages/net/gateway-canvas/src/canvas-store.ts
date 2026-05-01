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
  maxSurfacesPerTenant: 1_000,
} as const;

function resourceExhausted(message: string): KoiError {
  return { code: "RESOURCE_EXHAUSTED", message, retryable: true };
}

/**
 * The precondition token used by If-Match. Combines a per-store-instance
 * epoch with the generation, version, and content hash so that:
 *  - delete-then-recreate (same content) produces a fresh `generationId`
 *  - any update (incl. no-op) produces a fresh `version`
 *  - a process restart produces a fresh `instanceEpoch`
 * Stale PATCH/DELETE retries — even ones from before a process restart —
 * cannot impersonate a fence against a different surface generation.
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
 * Defensive clone for entries returned to callers. The store must NEVER
 * hand out a live reference to its internal map value: a caller mutating
 * `ownerId`, `contentHash`, `version`, or `metadata` in place would
 * corrupt the store's CAS/ownership invariants without going through
 * `update()`. Metadata is shallow-cloned and frozen because it can hold
 * arbitrary `unknown` shapes.
 */
function snapshotEntry(entry: SurfaceEntry): SurfaceEntry {
  // Deep-clone metadata so callers cannot mutate nested values to corrupt
  // stored state behind the store's CAS/version invariants. A shallow clone
  // (`{...entry.metadata}`) leaves nested objects/arrays shared by reference,
  // letting `entry.metadata.foo.bar = "x"` silently change the stored row
  // without bumping `version`/`etag`. Bun's runtime structuredClone handles
  // arbitrary `unknown` shapes (objects, arrays, dates, maps, sets).
  return Object.freeze({
    ...entry,
    ...(entry.metadata !== undefined ? { metadata: structuredClone(entry.metadata) } : {}),
  });
}

export function createInMemorySurfaceStore(
  configOverrides?: Partial<SurfaceStoreConfig>,
): SurfaceStore {
  const config: SurfaceStoreConfig = { ...DEFAULT_SURFACE_STORE_CONFIG, ...configOverrides };
  // Tenant-scoped keys prevent cross-tenant `surfaceId` squatting and
  // existence-probing. Two different agents can hold the same `surfaceId`
  // independently; the namespace is per-`ownerId`. Unowned entries (no
  // ownerId) live in their own slot and are unreachable through the
  // authenticated HTTP API.
  const map = new Map<string, SurfaceEntry>();
  // Per-tenant counts. Tracked separately from `map` so `create` admission
  // can enforce the per-tenant quota in O(1) without scanning the whole
  // store. Decremented on `delete`.
  const perTenantCount = new Map<string, number>();
  // let: monotonic per-store generation counter; bumped on every create
  let generationCounter = 0;
  // Per-store-instance random epoch. Embedded in every etag so that a
  // process restart (which resets `generationCounter` to 0) cannot reissue
  // an etag that collides with one held by a pre-restart client. 128 bits
  // of randomness — collision probability is computationally negligible.
  const instanceEpoch = computeStringHash(`${Date.now()}-${Math.random()}-${Math.random()}`).slice(
    0,
    16,
  );

  // `undefined` (no owner) and `""` (empty-string owner) MUST encode to
  // distinct keys. Without the leading discriminator byte, an authenticator
  // that returns `agentId: ""` would alias the ownerless namespace and let
  // a "blank" tenant read/mutate orphaned rows.
  function keyOf(id: string, ownerId: string | undefined): string {
    const tenant = ownerId === undefined ? "\x01" : `\x02${ownerId}`;
    return `${tenant}\x00${id}`;
  }

  function tenantOf(ownerId: string | undefined): string {
    return ownerId === undefined ? "\x01" : `\x02${ownerId}`;
  }

  return {
    get(id, ownerId) {
      const entry = map.get(keyOf(id, ownerId));
      if (entry === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      const accessed: SurfaceEntry = { ...entry, lastAccessedAt: Date.now() };
      map.set(keyOf(id, ownerId), accessed);
      return { ok: true, value: snapshotEntry(accessed) };
    },

    create(id, content, options) {
      const ownerId = options?.ownerId;
      const key = keyOf(id, ownerId);
      const existing = map.get(key);
      if (existing !== undefined) {
        // Same-tenant self-collision only — cross-tenant cannot collide
        // because keys are scoped by `ownerId`. Tenant A creating "home"
        // does not block tenant B from creating their own "home".
        return { ok: false, error: conflict(id, `Surface already exists: ${id}`) };
      }
      // Per-tenant quota first — primary admission control. Without this,
      // a noisy tenant can fill the global pool and 503 every other tenant.
      const tenant = tenantOf(ownerId);
      const tenantCount = perTenantCount.get(tenant) ?? 0;
      if (tenantCount >= config.maxSurfacesPerTenant) {
        return {
          ok: false,
          error: resourceExhausted(
            `Per-tenant surface quota reached (${config.maxSurfacesPerTenant}); delete a surface or raise maxSurfacesPerTenant`,
          ),
        };
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
        version: 1,
        etag: `${instanceEpoch}-${generationCounter}-1-${contentHash}`,
        generationId: generationCounter,
        instanceEpoch,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        ...(options?.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
        // Deep-clone metadata at ingress so post-create caller mutation
        // (including mutation of nested objects/arrays) cannot corrupt stored
        // state behind the store's CAS/version invariants.
        ...(options?.metadata !== undefined ? { metadata: structuredClone(options.metadata) } : {}),
      };
      map.set(key, entry);
      perTenantCount.set(tenant, tenantCount + 1);
      return { ok: true, value: snapshotEntry(entry) };
    },

    update(id, content, expectedEtag, expectedOwnerId) {
      const key = keyOf(id, expectedOwnerId);
      const existing = map.get(key);
      if (existing === undefined) {
        return { ok: false, error: notFound(id, `Surface not found: ${id}`) };
      }
      // Tenant-scoped lookup means a hit here already proves ownership.
      // Defense-in-depth assertion in case a durable backend stores
      // ownerId mutably.
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
      // Bump `version` on every successful update — including no-op updates
      // where content is unchanged. Without this, a no-op PATCH would not
      // advance the etag, leaving older If-Match tokens valid against later
      // writes/deletes (a stale-write acceptance bug).
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
      map.set(key, updated);
      return { ok: true, value: snapshotEntry(updated) };
    },

    delete(id, expectedOwnerId, expectedEtag) {
      const key = keyOf(id, expectedOwnerId);
      const existing = map.get(key);
      // Tenant-scoped lookup: a miss is genuinely "not present in this
      // tenant's namespace" → idempotent false. Defense-in-depth ownerId
      // assertion below.
      if (
        expectedOwnerId !== undefined &&
        existing !== undefined &&
        existing.ownerId !== expectedOwnerId
      ) {
        return { ok: false, error: permission(`Not the owner of surface: ${id}`) };
      }
      // Generation fence: the supplied token must match `surfaceEtag()` of
      // the current entry. A delete + recreate with identical content
      // produces a fresh generation, so stale tokens cannot impersonate
      // the new instance.
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
      const removed = map.delete(key);
      if (removed) {
        const tenant = tenantOf(expectedOwnerId);
        const count = perTenantCount.get(tenant) ?? 0;
        if (count <= 1) perTenantCount.delete(tenant);
        else perTenantCount.set(tenant, count - 1);
      }
      return { ok: true, value: removed };
    },

    has(id, ownerId) {
      return { ok: true, value: map.has(keyOf(id, ownerId)) };
    },

    size(): number {
      return map.size;
    },
  };
}

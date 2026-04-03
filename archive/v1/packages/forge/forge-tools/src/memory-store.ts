/**
 * InMemoryForgeStore — simple Map-based store for tests and development.
 * No eviction, no persistence across restarts.
 *
 * Features:
 * - Content integrity verification on load (recomputes BrickId from content)
 * - Store-level version tracking for optimistic locking on update
 */

import type {
  BrickArtifact,
  BrickId,
  BrickSummary,
  BrickUpdate,
  ForgeQuery,
  ForgeScope,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { conflict, notFound } from "@koi/core";
import {
  applyBrickUpdate,
  createMemoryStoreChangeNotifier,
  matchesBrickQuery,
  sortBricks,
} from "@koi/validation";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function notFoundError(id: BrickId): KoiError {
  return notFound(id, `Brick not found: ${id}`);
}

function versionConflictError(id: BrickId, expected: number, actual: number): KoiError {
  return conflict(
    id,
    `Version conflict on brick ${id}: expected version ${String(expected)}, current version ${String(actual)}`,
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface InMemoryForgeStoreConfig {
  /** Optional integrity check callback invoked on save. Return `{ ok: false }` to reject. */
  readonly verifyOnSave?: ((brick: BrickArtifact) => { readonly ok: boolean }) | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInMemoryForgeStore(config?: InMemoryForgeStoreConfig): ForgeStore {
  const bricks = new Map<BrickId, BrickArtifact>();
  const notifier = createMemoryStoreChangeNotifier();

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    // Write-time integrity verification (when configured)
    if (config?.verifyOnSave !== undefined) {
      const check = config.verifyOnSave(brick);
      if (!check.ok) {
        return {
          ok: false,
          error: conflict(brick.id, `Integrity check failed on save for brick ${brick.id}`),
        };
      }
    }
    // Stamp storeVersion=1 on first save (preserve existing if present)
    const versioned: BrickArtifact =
      brick.storeVersion !== undefined ? brick : { ...brick, storeVersion: 1 };
    bricks.set(versioned.id, versioned);
    notifier.notify({ kind: "saved", brickId: versioned.id });
    return { ok: true, value: undefined };
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const brick = bricks.get(id);
    if (brick === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    // Note: content integrity verification is intentionally NOT performed on
    // every load(). Bricks may have synthetic sha256-formatted IDs (tests, manual
    // creation) whose content doesn't match. Integrity should be verified
    // explicitly at trust boundaries (e.g., after download from remote registry)
    // via computeBrickId() + comparison, not on every read.
    return { ok: true, value: brick };
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    const filtered: BrickArtifact[] = [];
    for (const brick of bricks.values()) {
      if (matchesBrickQuery(brick, query)) {
        filtered.push(brick);
      }
    }
    const sorted = sortBricks(filtered, query, { nowMs: Date.now() });
    const limited = query.limit !== undefined ? sorted.slice(0, query.limit) : sorted;
    return { ok: true, value: limited };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    if (!bricks.has(id)) {
      return { ok: false, error: notFoundError(id) };
    }
    bricks.delete(id);
    notifier.notify({ kind: "removed", brickId: id });
    return { ok: true, value: undefined };
  };

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    // Optimistic locking: reject if version mismatch
    if (updates.expectedVersion !== undefined) {
      const currentVersion = existing.storeVersion ?? 0;
      if (currentVersion !== updates.expectedVersion) {
        return {
          ok: false,
          error: versionConflictError(id, updates.expectedVersion, currentVersion),
        };
      }
    }
    const applied = applyBrickUpdate(existing, updates);
    // Bump storeVersion on every successful update
    const nextVersion = (existing.storeVersion ?? 0) + 1;
    const versioned: BrickArtifact = { ...applied, storeVersion: nextVersion };
    bricks.set(id, versioned);
    notifier.notify({ kind: "updated", brickId: id });
    return { ok: true, value: undefined };
  };

  const searchSummaries = async (
    query: ForgeQuery,
  ): Promise<Result<readonly BrickSummary[], KoiError>> => {
    const result = await search(query);
    if (!result.ok) return result;
    const summaries: readonly BrickSummary[] = result.value.map(
      (brick: BrickArtifact): BrickSummary => ({
        id: brick.id,
        kind: brick.kind,
        name: brick.name,
        description: brick.description,
        tags: brick.tags,
        ...(brick.trigger !== undefined ? { trigger: brick.trigger } : {}),
      }),
    );
    return { ok: true, value: summaries };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: bricks.has(id) };
  };

  const promoteAndUpdate = async (
    id: BrickId,
    targetScope: ForgeScope,
    updates: BrickUpdate,
  ): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    // Optimistic locking for promote+update too
    if (updates.expectedVersion !== undefined) {
      const currentVersion = existing.storeVersion ?? 0;
      if (currentVersion !== updates.expectedVersion) {
        return {
          ok: false,
          error: versionConflictError(id, updates.expectedVersion, currentVersion),
        };
      }
    }
    const applied = applyBrickUpdate(existing, { ...updates, scope: targetScope });
    const nextVersion = (existing.storeVersion ?? 0) + 1;
    const versioned: BrickArtifact = { ...applied, storeVersion: nextVersion };
    bricks.set(id, versioned);
    notifier.notify({ kind: "promoted", brickId: id, scope: targetScope });
    return { ok: true, value: undefined };
  };

  return {
    save,
    load,
    search,
    searchSummaries,
    remove,
    update,
    exists,
    promoteAndUpdate,
    watch: notifier.subscribe,
  };
}

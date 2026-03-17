/**
 * InMemoryForgeStore — simple Map-based store for tests and development.
 * No eviction, no persistence across restarts.
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
import { notFound } from "@koi/core";
import {
  applyBrickUpdate,
  createMemoryStoreChangeNotifier,
  matchesBrickQuery,
  sortBricks,
} from "@koi/validation";

// Error helpers use shared factories from @koi/core.
function notFoundError(id: BrickId): KoiError {
  return notFound(id, `Brick not found: ${id}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInMemoryForgeStore(): ForgeStore {
  const bricks = new Map<BrickId, BrickArtifact>();
  const notifier = createMemoryStoreChangeNotifier();

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    bricks.set(brick.id, brick);
    notifier.notify({ kind: "saved", brickId: brick.id });
    return { ok: true, value: undefined };
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const brick = bricks.get(id);
    if (brick === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
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
    bricks.set(id, applyBrickUpdate(existing, updates));
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
    const merged = applyBrickUpdate(existing, { ...updates, scope: targetScope });
    bricks.set(id, merged);
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

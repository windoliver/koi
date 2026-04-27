/**
 * In-memory ForgeStore — Map-backed implementation for tests and the
 * default in-process forge tools backend.
 *
 * Task 3 scope: basic CRUD + sortable search + change notifications.
 * Idempotent retry, content-integrity verification, scope-update rejection,
 * and optimistic locking are added in Tasks 4 and 5.
 */

import type {
  BrickArtifact,
  BrickId,
  BrickSummary,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import {
  applyBrickUpdate,
  createMemoryStoreChangeNotifier,
  matchesBrickQuery,
  sortBricks,
} from "@koi/validation";
import { conflict, notFound } from "./shared.js";

function notFoundError(id: BrickId): KoiError {
  return notFound(id, `Brick not found: ${id}`);
}

function toSummary(brick: BrickArtifact): BrickSummary {
  return {
    id: brick.id,
    kind: brick.kind,
    name: brick.name,
    description: brick.description,
    tags: brick.tags,
    ...(brick.trigger !== undefined ? { trigger: brick.trigger } : {}),
  };
}

export function createInMemoryForgeStore(): ForgeStore {
  const bricks = new Map<BrickId, BrickArtifact>();
  const notifier = createMemoryStoreChangeNotifier();

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    if (bricks.has(brick.id)) {
      return {
        ok: false,
        error: conflict(brick.id, `Brick already exists: ${brick.id}`),
      };
    }
    const versioned: BrickArtifact =
      brick.storeVersion !== undefined ? brick : { ...brick, storeVersion: 1 };
    bricks.set(versioned.id, versioned);
    notifier.notify({ kind: "saved", brickId: versioned.id, scope: versioned.scope });
    return { ok: true, value: undefined };
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const brick = bricks.get(id);
    if (brick === undefined) return { ok: false, error: notFoundError(id) };
    return { ok: true, value: brick };
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    const filtered: BrickArtifact[] = [];
    for (const brick of bricks.values()) {
      if (matchesBrickQuery(brick, query)) filtered.push(brick);
    }
    const sorted = sortBricks(filtered, query, { nowMs: Date.now() });
    const limited = query.limit !== undefined ? sorted.slice(0, query.limit) : sorted;
    return { ok: true, value: limited };
  };

  const searchSummaries = async (
    query: ForgeQuery,
  ): Promise<Result<readonly BrickSummary[], KoiError>> => {
    const result = await search(query);
    if (!result.ok) return result;
    return { ok: true, value: result.value.map(toSummary) };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    if (!bricks.has(id)) return { ok: false, error: notFoundError(id) };
    bricks.delete(id);
    notifier.notify({ kind: "removed", brickId: id });
    return { ok: true, value: undefined };
  };

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) return { ok: false, error: notFoundError(id) };
    const applied = applyBrickUpdate(existing, updates);
    const nextVersion = (existing.storeVersion ?? 0) + 1;
    const versioned: BrickArtifact = { ...applied, storeVersion: nextVersion };
    bricks.set(id, versioned);
    notifier.notify({ kind: "updated", brickId: id, scope: versioned.scope });
    return { ok: true, value: undefined };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: bricks.has(id) };
  };

  return {
    save,
    load,
    search,
    searchSummaries,
    remove,
    update,
    exists,
    watch: notifier.subscribe,
  };
}

/**
 * InMemoryForgeStore — simple Map-based store for tests and development.
 * No eviction, no persistence across restarts.
 */

import type {
  BrickArtifact,
  BrickId,
  BrickUpdate,
  ForgeQuery,
  ForgeScope,
  ForgeStore,
  KoiError,
  Result,
  StoreChangeEvent,
} from "@koi/core";
import { notFound } from "@koi/core";
import { applyBrickUpdate, matchesBrickQuery } from "@koi/validation";

// Error helpers use shared factories from @koi/core.
function notFoundError(id: BrickId): KoiError {
  return notFound(id, `Brick not found: ${id}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInMemoryForgeStore(): ForgeStore {
  const bricks = new Map<BrickId, BrickArtifact>();

  // --- watch notification ---
  const changeListeners = new Set<(event: StoreChangeEvent) => void>();

  const notifyListeners = (event: StoreChangeEvent): void => {
    for (const listener of changeListeners) {
      try {
        listener(event);
      } catch (_err: unknown) {
        // Listener errors must not break the mutation return path or skip other listeners.
      }
    }
  };

  const watch = (listener: (event: StoreChangeEvent) => void): (() => void) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  };

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    bricks.set(brick.id, brick);
    notifyListeners({ kind: "saved", brickId: brick.id });
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
    const results: BrickArtifact[] = [];
    for (const brick of bricks.values()) {
      if (matchesBrickQuery(brick, query)) {
        results.push(brick);
        if (query.limit !== undefined && results.length >= query.limit) {
          break;
        }
      }
    }
    return { ok: true, value: results };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    if (!bricks.has(id)) {
      return { ok: false, error: notFoundError(id) };
    }
    bricks.delete(id);
    notifyListeners({ kind: "removed", brickId: id });
    return { ok: true, value: undefined };
  };

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    bricks.set(id, applyBrickUpdate(existing, updates));
    notifyListeners({ kind: "updated", brickId: id });
    return { ok: true, value: undefined };
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
    notifyListeners({ kind: "promoted", brickId: id, scope: targetScope });
    return { ok: true, value: undefined };
  };

  return { save, load, search, remove, update, exists, promoteAndUpdate, watch };
}

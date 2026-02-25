/**
 * InMemoryForgeStore — simple Map-based store for tests and development.
 * No eviction, no persistence across restarts.
 */

import type {
  BrickArtifact,
  BrickId,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
  StoreChangeEvent,
} from "@koi/core";
import { notFound } from "@koi/core";

// Error helpers use shared factories from @koi/core.
function notFoundError(id: BrickId): KoiError {
  return notFound(id, `Brick not found: ${id}`);
}

function matchesQuery(brick: BrickArtifact, query: ForgeQuery): boolean {
  if (query.kind !== undefined && brick.kind !== query.kind) {
    return false;
  }
  if (query.scope !== undefined && brick.scope !== query.scope) {
    return false;
  }
  if (query.trustTier !== undefined && brick.trustTier !== query.trustTier) {
    return false;
  }
  if (query.lifecycle !== undefined && brick.lifecycle !== query.lifecycle) {
    return false;
  }
  if (query.createdBy !== undefined && brick.provenance.metadata.agentId !== query.createdBy) {
    return false;
  }
  if (
    query.classification !== undefined &&
    brick.provenance.classification !== query.classification
  ) {
    return false;
  }
  if (query.contentMarkers !== undefined && query.contentMarkers.length > 0) {
    for (const marker of query.contentMarkers) {
      if (!brick.provenance.contentMarkers.includes(marker)) {
        return false;
      }
    }
  }
  // Tags use AND-subset matching: brick must contain all query tags
  if (query.tags !== undefined && query.tags.length > 0) {
    for (const tag of query.tags) {
      if (!brick.tags.includes(tag)) {
        return false;
      }
    }
  }
  // Case-insensitive substring match against name + description
  if (query.text !== undefined && query.text.length > 0) {
    const lower = query.text.toLowerCase();
    if (
      !brick.name.toLowerCase().includes(lower) &&
      !brick.description.toLowerCase().includes(lower)
    ) {
      return false;
    }
  }
  return true;
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
      if (matchesQuery(brick, query)) {
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
    const updated: BrickArtifact = {
      ...existing,
      ...(updates.lifecycle !== undefined ? { lifecycle: updates.lifecycle } : {}),
      ...(updates.trustTier !== undefined ? { trustTier: updates.trustTier } : {}),
      ...(updates.scope !== undefined ? { scope: updates.scope } : {}),
      ...(updates.usageCount !== undefined ? { usageCount: updates.usageCount } : {}),
      ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
    };
    bricks.set(id, updated);
    notifyListeners({ kind: "updated", brickId: id });
    return { ok: true, value: undefined };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: bricks.has(id) };
  };

  return { save, load, search, remove, update, exists, watch };
}

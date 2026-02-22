/**
 * InMemoryForgeStore — simple Map-based store for tests and development.
 * No eviction, no persistence across restarts.
 */

import type {
  BrickArtifact,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFoundError(id: string): KoiError {
  return { code: "NOT_FOUND", message: `Brick not found: ${id}`, retryable: false };
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
  if (query.createdBy !== undefined && brick.createdBy !== query.createdBy) {
    return false;
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
  const bricks = new Map<string, BrickArtifact>();

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    bricks.set(brick.id, brick);
    return { ok: true, value: undefined };
  };

  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
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

  const remove = async (id: string): Promise<Result<void, KoiError>> => {
    if (!bricks.has(id)) {
      return { ok: false, error: notFoundError(id) };
    }
    bricks.delete(id);
    return { ok: true, value: undefined };
  };

  const update = async (id: string, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
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
    };
    bricks.set(id, updated);
    return { ok: true, value: undefined };
  };

  const exists = async (id: string): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: bricks.has(id) };
  };

  return { save, load, search, remove, update, exists };
}

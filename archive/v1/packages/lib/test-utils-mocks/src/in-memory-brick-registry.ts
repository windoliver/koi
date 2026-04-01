/**
 * In-memory BrickRegistryBackend implementation for testing.
 *
 * Stores bricks in a Map keyed by "kind:name". Supports search, get,
 * register, unregister, and onChange notifications.
 */

import type {
  BrickArtifact,
  BrickKind,
  BrickPage,
  BrickRegistryBackend,
  BrickRegistryChangeEvent,
  BrickSearchQuery,
  KoiError,
  Result,
} from "@koi/core";
import { DEFAULT_BRICK_SEARCH_LIMIT } from "@koi/core";

function registryKey(kind: BrickKind, name: string): string {
  return `${kind}:${name}`;
}

export function createInMemoryBrickRegistry(): BrickRegistryBackend {
  const bricks = new Map<string, BrickArtifact>();
  const listeners = new Set<(event: BrickRegistryChangeEvent) => void>();

  function notify(event: BrickRegistryChangeEvent): void {
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  const search = (query: BrickSearchQuery): BrickPage => {
    const limit = query.limit ?? DEFAULT_BRICK_SEARCH_LIMIT;
    const all = [...bricks.values()];

    const filtered = all.filter((brick) => {
      if (query.kind !== undefined && brick.kind !== query.kind) return false;
      if (query.text !== undefined) {
        const lower = query.text.toLowerCase();
        if (
          !brick.name.toLowerCase().includes(lower) &&
          !brick.description.toLowerCase().includes(lower)
        ) {
          return false;
        }
      }
      if (query.namespace !== undefined && brick.namespace !== query.namespace) return false;
      if (query.tags !== undefined && query.tags.length > 0) {
        for (const tag of query.tags) {
          if (!brick.tags.includes(tag)) return false;
        }
      }
      return true;
    });

    // Cursor-based pagination using index offset
    const startIndex = query.cursor !== undefined ? Number(query.cursor) : 0;
    const page = filtered.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const hasMore = nextIndex < filtered.length;

    return {
      items: page,
      ...(hasMore ? { cursor: String(nextIndex) } : {}),
      total: filtered.length,
    };
  };

  const get = (
    kind: BrickKind,
    name: string,
    namespace?: string,
  ): Result<BrickArtifact, KoiError> => {
    const key = registryKey(kind, name);
    const brick = bricks.get(key);
    if (brick === undefined || (namespace !== undefined && brick.namespace !== namespace)) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Brick ${kind}:${name} not found`,
          retryable: false,
        },
      };
    }
    return { ok: true, value: brick };
  };

  const register = (brick: BrickArtifact): Result<void, KoiError> => {
    const key = registryKey(brick.kind, brick.name);
    bricks.set(key, brick);
    notify({ kind: "registered", brickKind: brick.kind, name: brick.name });
    return { ok: true, value: undefined };
  };

  const unregister = (kind: BrickKind, name: string): Result<void, KoiError> => {
    const key = registryKey(kind, name);
    if (!bricks.has(key)) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Brick ${kind}:${name} not found`,
          retryable: false,
        },
      };
    }
    bricks.delete(key);
    notify({ kind: "unregistered", brickKind: kind, name });
    return { ok: true, value: undefined };
  };

  const onChange = (listener: (event: BrickRegistryChangeEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { search, get, register, unregister, onChange };
}

/**
 * MemoryStore → MemoryToolBackend adapter.
 *
 * Bridges @koi/memory-fs (MemoryStore — file-based CRUD) to
 * @koi/memory-tools (MemoryToolBackend — tool DI seam). Lives in the
 * meta layer because it imports from two L2 packages.
 *
 * MemoryStore throws on errors and returns plain values.
 * MemoryToolBackend returns Result<T, KoiError>. The adapter wraps
 * every call in try/catch and maps thrown errors to Result.error.
 */

import type { KoiError, Result } from "@koi/core";
import type { MemoryStore, UpsertResult } from "@koi/memory-fs";
import type { DeleteResult, MemoryToolBackend, StoreWithDedupResult } from "@koi/memory-tools";

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapError(e: unknown): KoiError {
  const message = e instanceof Error ? e.message : String(e);
  return { code: "INTERNAL", message, retryable: false };
}

function ok<T>(value: T): Result<T, KoiError> {
  return { ok: true, value };
}

function fail<T>(e: unknown): Result<T, KoiError> {
  return { ok: false, error: mapError(e) };
}

// ---------------------------------------------------------------------------
// UpsertResult → StoreWithDedupResult mapping
// ---------------------------------------------------------------------------

function mapUpsertResult(result: UpsertResult): StoreWithDedupResult {
  switch (result.action) {
    case "created":
      return { action: "created", record: result.record };
    case "updated":
      return { action: "updated", record: result.record };
    case "conflict":
      return { action: "conflict", existing: result.existing };
    case "skipped":
      return { action: "conflict", existing: result.record };
    case "corrupted":
      return {
        action: "corrupted",
        canonicalName: result.canonicalName,
        conflictingIds: result.conflictingIds,
      };
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Adapt a file-based MemoryStore to the MemoryToolBackend interface
 * consumed by memory tools.
 *
 * Limitations vs. a full backend:
 * - `recall()` returns all records (no semantic search). The model's
 *   `memory_recall` tool works but ranking is caller-side.
 * - `search()` does substring matching on name/description/content.
 *   No full-text index.
 */
export function createMemoryToolBackendFromStore(store: MemoryStore): MemoryToolBackend {
  return {
    store: async (input) => {
      try {
        const result = await store.write(input);
        return ok(result.record);
      } catch (e: unknown) {
        return fail(e);
      }
    },

    storeWithDedup: async (input, opts) => {
      try {
        const result = await store.upsert(input, { force: opts.force });
        return ok(mapUpsertResult(result));
      } catch (e: unknown) {
        return fail(e);
      }
    },

    recall: async (_query, _options) => {
      try {
        // No semantic search — return all records. The recall pipeline
        // in @koi/memory handles scoring and budgeting separately.
        const all = await store.list();
        return ok(all);
      } catch (e: unknown) {
        return fail(e);
      }
    },

    search: async (filter) => {
      try {
        const all = await store.list(filter.type !== undefined ? { type: filter.type } : undefined);

        // Apply keyword filter (substring match on name, description, content)
        const keyword = filter.keyword?.toLowerCase();
        const filtered =
          keyword !== undefined
            ? all.filter(
                (r) =>
                  r.name.toLowerCase().includes(keyword) ||
                  r.description.toLowerCase().includes(keyword) ||
                  r.content.toLowerCase().includes(keyword),
              )
            : [...all];

        // Apply timestamp filters
        const afterMs = filter.updatedAfter;
        const beforeMs = filter.updatedBefore;
        const timeFiltered = filtered.filter((r) => {
          if (afterMs !== undefined && r.updatedAt < afterMs) return false;
          if (beforeMs !== undefined && r.updatedAt > beforeMs) return false;
          return true;
        });

        // Apply limit
        const limit = filter.limit;
        const limited = limit !== undefined ? timeFiltered.slice(0, limit) : timeFiltered;

        return ok(limited);
      } catch (e: unknown) {
        return fail(e);
      }
    },

    delete: async (id) => {
      try {
        const result = await store.delete(id);
        const mapped: DeleteResult = { wasPresent: result.deleted };
        return ok(mapped);
      } catch (e: unknown) {
        return fail(e);
      }
    },

    findByName: async (name, type) => {
      try {
        const all = await store.list(type !== undefined ? { type } : undefined);
        const match = all.find((r) => r.name === name);
        return ok(match);
      } catch (e: unknown) {
        return fail(e);
      }
    },

    get: async (id) => {
      try {
        const record = await store.read(id);
        return ok(record);
      } catch (e: unknown) {
        return fail(e);
      }
    },

    update: async (id, patch) => {
      try {
        const result = await store.update(id, patch);
        return ok(result.record);
      } catch (e: unknown) {
        return fail(e);
      }
    },
  };
}

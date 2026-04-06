/**
 * Shared test helpers — mock MemoryToolBackend for tool unit tests.
 */

import type { KoiError, MemoryRecord, MemoryRecordInput, Result } from "@koi/core";
import { memoryRecordId } from "@koi/core";
import type {
  DeleteResult,
  MemoryToolBackend,
  StoreWithDedupOptions,
  StoreWithDedupResult,
} from "../types.js";

/** Create a mock MemoryRecord for testing. */
export function mockRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: memoryRecordId("rec-1"),
    name: "test memory",
    description: "a test memory record",
    type: "user",
    content: "Some content here.",
    filePath: "user_test.md",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

/** Create a mock backend where every method can be overridden. */
export function mockBackend(overrides?: Partial<MemoryToolBackend>): MemoryToolBackend {
  const ok = <T>(value: T): Result<T, KoiError> => ({ ok: true, value });
  const record = mockRecord();

  return {
    store: async () => ok(record),
    storeWithDedup: async (_input: MemoryRecordInput, _opts: StoreWithDedupOptions) =>
      ok({ action: "created", record } as StoreWithDedupResult),
    recall: async () => ok([]),
    search: async () => ok([]),
    delete: async () => ok({ wasPresent: true } as DeleteResult),
    findByName: async () => ok(undefined),
    get: async () => ok(record),
    update: async () => ok(record),
    ...overrides,
  };
}

/**
 * Create an atomic in-memory backend for concurrency tests.
 *
 * Uses a Map for storage; single JS tick = trivially atomic for storeWithDedup.
 */
export function atomicInMemoryBackend(): MemoryToolBackend & {
  readonly records: ReadonlyMap<string, MemoryRecord>;
} {
  const records = new Map<string, MemoryRecord>();
  // let — monotonic counter for generating unique IDs
  let counter = 0;

  const ok = <T>(value: T): Result<T, KoiError> => ({ ok: true, value });

  /** Deterministic key for name+type dedup. */
  function dedupKey(name: string, type: string): string {
    return `${type}::${name}`;
  }

  /** Index of dedupKey → record id for fast lookup. */
  const dedupIndex = new Map<string, string>();

  function makeRecord(input: MemoryRecordInput, id: string): MemoryRecord {
    const now = Date.now();
    return {
      id: memoryRecordId(id),
      name: input.name,
      description: input.description,
      type: input.type,
      content: input.content,
      filePath: `${input.type}_${id}.md`,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    records,

    store: (input) => {
      counter += 1;
      const id = `rec-${String(counter)}`;
      const record = makeRecord(input, id);
      records.set(id, record);
      dedupIndex.set(dedupKey(input.name, input.type), id);
      return ok(record);
    },

    storeWithDedup: (input, opts) => {
      const key = dedupKey(input.name, input.type);
      const existingId = dedupIndex.get(key);

      if (existingId !== undefined) {
        const existing = records.get(existingId);
        if (existing !== undefined) {
          if (!opts.force) {
            return ok({ action: "conflict", existing } as StoreWithDedupResult);
          }
          // force=true: update in place
          const updated: MemoryRecord = {
            ...existing,
            description: input.description,
            content: input.content,
            updatedAt: Date.now(),
          };
          records.set(existingId, updated);
          return ok({ action: "updated", record: updated } as StoreWithDedupResult);
        }
        // Index stale — existing record was deleted; clean up and fall through to create
        dedupIndex.delete(key);
      }

      counter += 1;
      const id = `rec-${String(counter)}`;
      const record = makeRecord(input, id);
      records.set(id, record);
      dedupIndex.set(key, id);
      return ok({ action: "created", record } as StoreWithDedupResult);
    },

    recall: () => ok([...records.values()]),

    search: () => ok([...records.values()]),

    delete: (id) => {
      const existing = records.get(id);
      if (existing === undefined) {
        return ok({ wasPresent: false } as DeleteResult);
      }
      records.delete(id);
      // Clean dedup index
      dedupIndex.delete(dedupKey(existing.name, existing.type));
      return ok({ wasPresent: true } as DeleteResult);
    },

    findByName: (name, type) => {
      const match = [...records.values()].find(
        (r) => r.name === name && (type === undefined || r.type === type),
      );
      return ok(match);
    },

    get: (id) => ok(records.get(id)),

    update: (id, patch) => {
      const existing = records.get(id);
      if (existing === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Record not found: ${id}`, retryable: false },
        };
      }
      const updated: MemoryRecord = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        updatedAt: Date.now(),
      };
      records.set(id, updated);
      return ok(updated);
    },
  };
}

/** Create a KoiError for test use. */
export function mockError(message = "backend failure"): KoiError {
  return { code: "INTERNAL", message, retryable: false };
}

/** Unwrap a Result<Tool, KoiError> or throw for cleaner test assertions. */
export function unwrapTool<T>(result: Result<T, KoiError>): T {
  if (!result.ok) throw new Error(`Expected ok result, got error: ${result.error.message}`);
  return result.value;
}

/** Helper to extract a branded MemoryRecordId. */
export { memoryRecordId };

/** Default test memory directory (absolute path for sandbox cap validation). */
export const TEST_MEMORY_DIR = "/tmp/koi-test-memory";

/**
 * Shared test helpers — mock MemoryToolBackend for tool unit tests.
 */

import type { KoiError, MemoryRecord, Result } from "@koi/core";
import { memoryRecordId } from "@koi/core";
import type { MemoryToolBackend } from "../types.js";

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
    recall: async () => ok([]),
    search: async () => ok([]),
    delete: async () => ok(undefined),
    findByName: async () => ok(undefined),
    get: async () => ok(record),
    update: async () => ok(record),
    ...overrides,
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

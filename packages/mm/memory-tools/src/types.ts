/**
 * Memory tool types — DI interface and configuration for memory tool factories.
 *
 * MemoryToolBackend is the seam between tool surfaces and the backing store.
 * It is richer than the ECS MemoryComponent (which only has store/recall)
 * because tools also need search, delete, findByName, get, and update.
 */

import type {
  KoiError,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordInput,
  MemoryRecordPatch,
  MemoryTier,
  MemoryType,
  Result,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Atomic store result
// ---------------------------------------------------------------------------

/** Discriminated result of an atomic store-with-dedup operation. */
export type StoreWithDedupResult =
  | { readonly action: "created"; readonly record: MemoryRecord }
  | { readonly action: "updated"; readonly record: MemoryRecord }
  | { readonly action: "conflict"; readonly existing: MemoryRecord };

/** Options for storeWithDedup. */
export interface StoreWithDedupOptions {
  /** When true, overwrite an existing record with the same name+type. */
  readonly force: boolean;
}

// ---------------------------------------------------------------------------
// Idempotent delete result
// ---------------------------------------------------------------------------

/** Result of an idempotent delete operation. */
export interface DeleteResult {
  /** Whether the record was present and actually removed (false = already absent). */
  readonly wasPresent: boolean;
}

// ---------------------------------------------------------------------------
// Recall options
// ---------------------------------------------------------------------------

/** Options for the memory_recall tool's backend call. */
export interface MemoryToolRecallOptions {
  readonly limit?: number | undefined;
  readonly tierFilter?: MemoryTier | "all" | undefined;
  readonly graphExpand?: boolean | undefined;
  readonly maxHops?: number | undefined;
}

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

/** Filter criteria for the memory_search tool. */
export interface MemorySearchFilter {
  readonly keyword?: string | undefined;
  readonly type?: MemoryType | undefined;
  readonly updatedAfter?: number | undefined;
  readonly updatedBefore?: number | undefined;
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Backend interface (DI seam)
// ---------------------------------------------------------------------------

/**
 * DI interface between memory tools and the backing store.
 *
 * Implementations may be filesystem-backed (production) or in-memory (test).
 * Methods return `T | Promise<T>` so sync implementations work without wrapping.
 * All callers must `await` (await on a non-Promise is a no-op).
 */
export interface MemoryToolBackend {
  readonly store: (
    input: MemoryRecordInput,
  ) => Result<MemoryRecord, KoiError> | Promise<Result<MemoryRecord, KoiError>>;

  /**
   * Atomically store a memory record with name+type dedup.
   *
   * Contract:
   * - `force=false` + existing match by `(name, type)` → `{ action: "conflict", existing }`
   * - `force=false` + no match → `{ action: "created", record }`
   * - `force=true` + existing match → `{ action: "updated", record }`
   * - `force=true` + no match → `{ action: "created", record }`
   *
   * Implementations MUST enforce name-uniqueness-per-type atomically.
   * For in-memory backends (single JS tick), Map operations are trivially atomic.
   * For filesystem backends, use exclusive file creation (O_EXCL / `wx` flag).
   */
  readonly storeWithDedup: (
    input: MemoryRecordInput,
    opts: StoreWithDedupOptions,
  ) => Result<StoreWithDedupResult, KoiError> | Promise<Result<StoreWithDedupResult, KoiError>>;

  readonly recall: (
    query: string,
    options?: MemoryToolRecallOptions,
  ) =>
    | Result<readonly MemoryRecord[], KoiError>
    | Promise<Result<readonly MemoryRecord[], KoiError>>;

  readonly search: (
    filter: MemorySearchFilter,
  ) =>
    | Result<readonly MemoryRecord[], KoiError>
    | Promise<Result<readonly MemoryRecord[], KoiError>>;

  /**
   * Idempotent delete — removes a record by ID.
   *
   * Returns `{ wasPresent: true }` if the record existed and was removed,
   * `{ wasPresent: false }` if it was already absent. Both are success.
   * Only returns an error Result on infrastructure failures.
   */
  readonly delete: (
    id: MemoryRecordId,
  ) => Result<DeleteResult, KoiError> | Promise<Result<DeleteResult, KoiError>>;

  readonly findByName: (
    name: string,
    type?: MemoryType,
  ) =>
    | Result<MemoryRecord | undefined, KoiError>
    | Promise<Result<MemoryRecord | undefined, KoiError>>;

  readonly get: (
    id: MemoryRecordId,
  ) =>
    | Result<MemoryRecord | undefined, KoiError>
    | Promise<Result<MemoryRecord | undefined, KoiError>>;

  readonly update: (
    id: MemoryRecordId,
    patch: MemoryRecordPatch,
  ) => Result<MemoryRecord, KoiError> | Promise<Result<MemoryRecord, KoiError>>;
}

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

/** Configuration for createMemoryToolProvider. */
export interface MemoryToolProviderConfig {
  readonly backend: MemoryToolBackend;
  /**
   * Absolute path to the memory storage directory.
   * Used to declare filesystem capabilities on the tool sandbox boundary.
   * Must be an absolute path (starts with `/`).
   */
  readonly memoryDir: string;
  readonly prefix?: string | undefined;
  readonly recallLimit?: number | undefined;
  readonly searchLimit?: number | undefined;
  readonly priority?: number | undefined;
}

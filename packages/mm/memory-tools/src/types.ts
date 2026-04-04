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
  MemoryType,
  Result,
  ToolPolicy,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Recall options
// ---------------------------------------------------------------------------

/** Options for the memory_recall tool's backend call. */
export interface MemoryToolRecallOptions {
  readonly limit?: number | undefined;
  readonly tierFilter?: string | undefined;
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
 * All methods return Result to surface expected failures without throwing.
 */
export interface MemoryToolBackend {
  readonly store: (input: MemoryRecordInput) => Promise<Result<MemoryRecord, KoiError>>;

  readonly recall: (
    query: string,
    options?: MemoryToolRecallOptions,
  ) => Promise<Result<readonly MemoryRecord[], KoiError>>;

  readonly search: (
    filter: MemorySearchFilter,
  ) => Promise<Result<readonly MemoryRecord[], KoiError>>;

  readonly delete: (id: MemoryRecordId) => Promise<Result<void, KoiError>>;

  readonly findByName: (
    name: string,
    type?: MemoryType,
  ) => Promise<Result<MemoryRecord | undefined, KoiError>>;

  readonly get: (id: MemoryRecordId) => Promise<Result<MemoryRecord | undefined, KoiError>>;

  readonly update: (
    id: MemoryRecordId,
    patch: MemoryRecordPatch,
  ) => Promise<Result<MemoryRecord, KoiError>>;
}

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

/** Configuration for createMemoryToolProvider. */
export interface MemoryToolProviderConfig {
  readonly backend: MemoryToolBackend;
  readonly prefix?: string | undefined;
  readonly recallLimit?: number | undefined;
  readonly searchLimit?: number | undefined;
  readonly policy?: ToolPolicy | undefined;
  readonly priority?: number | undefined;
}

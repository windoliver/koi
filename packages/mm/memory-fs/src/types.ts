/**
 * Memory store types — CRUD interface, config, and result shapes.
 *
 * These types are L2-local. The L0 domain types (MemoryRecord,
 * MemoryRecordInput, etc.) live in @koi/core.
 */

import type {
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordInput,
  MemoryRecordPatch,
  MemoryType,
} from "@koi/core/memory";

/** Filter for listing memory records. */
export interface MemoryListFilter {
  readonly type?: MemoryType;
}

/** Operations that can surface an index rebuild error. */
export type MemoryStoreOperation = "write" | "update" | "delete" | "rebuild";

/**
 * Index-error callback. Invoked whenever MEMORY.md rebuild fails after a
 * successful record mutation. The record is already on disk; the index
 * has diverged from the store and should be repaired.
 *
 * The callback is for observability only. It is invoked fire-and-forget:
 * a slow callback will NOT delay the mutation's return, and rejections
 * from the callback are silently dropped. Correctness flows through the
 * `indexError` field on the mutation return values, which is always
 * populated on rebuild failure.
 */
export type IndexErrorCallback = (
  error: unknown,
  context: { readonly operation: MemoryStoreOperation },
) => void | Promise<void>;

/** Result of a write operation — communicates dedup outcome. */
export interface DedupResult {
  readonly action: "created" | "skipped";
  readonly record: MemoryRecord;
  /** When skipped, the ID of the existing duplicate. */
  readonly duplicateOf?: MemoryRecordId | undefined;
  /** Jaccard similarity score when a duplicate was found. */
  readonly similarity?: number | undefined;
  /**
   * Populated only if MEMORY.md rebuild failed after the mutation.
   * The record is still on disk and readable; the index is stale.
   */
  readonly indexError?: unknown;
}

/** Result of an update operation. */
export interface UpdateResult {
  readonly record: MemoryRecord;
  /** Populated only if MEMORY.md rebuild failed after the mutation. */
  readonly indexError?: unknown;
}

/** Result of a delete operation. */
export interface DeleteResult {
  readonly deleted: boolean;
  /** Populated only if MEMORY.md rebuild failed after the mutation. */
  readonly indexError?: unknown;
}

/** Configuration for creating a MemoryStore. */
export interface MemoryStoreConfig {
  /** Resolved absolute path to the memory directory. */
  readonly dir: string;
  /** Jaccard similarity threshold for dedup (default 0.7). */
  readonly dedupThreshold?: number | undefined;
  /**
   * Observability hook invoked (and awaited) when MEMORY.md rebuild fails.
   * Mutations still succeed — this is not an error path.
   */
  readonly onIndexError?: IndexErrorCallback | undefined;
}

/** Default dedup threshold — matches v1 behavior. */
export const DEFAULT_DEDUP_THRESHOLD = 0.7;

/**
 * File-based memory store — CRUD operations on memory records.
 *
 * Each record is a Markdown file with bespoke frontmatter.
 * A MEMORY.md index is rebuilt on every mutation.
 *
 * The record-level file operation for each mutation is serialized
 * per-directory: concurrent writes in the same process are queued via
 * an in-process mutex, and cross-process writes coordinate via a
 * `.memory.lock` file. This guarantees dedup scans are atomic with
 * record creation. The post-mutation index rebuild and onIndexError
 * callback run outside the lock so slow observers cannot stall writers.
 */
export interface MemoryStore {
  readonly read: (id: MemoryRecordId) => Promise<MemoryRecord | undefined>;
  readonly write: (input: MemoryRecordInput) => Promise<DedupResult>;
  readonly update: (id: MemoryRecordId, patch: MemoryRecordPatch) => Promise<UpdateResult>;
  readonly delete: (id: MemoryRecordId) => Promise<DeleteResult>;
  readonly list: (filter?: MemoryListFilter) => Promise<readonly MemoryRecord[]>;
  /**
   * Rebuild MEMORY.md from a fresh disk scan. Acquires the same per-dir
   * lock as writes. Throws on failure (unlike the best-effort rebuild
   * performed after each mutation).
   */
  readonly rebuildIndex: () => Promise<void>;
}

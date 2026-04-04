/**
 * Memory store types — CRUD interface, config, and dedup result.
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

/** Result of a write operation — communicates dedup outcome. */
export interface DedupResult {
  readonly action: "created" | "skipped";
  readonly record: MemoryRecord;
  /** When skipped, the ID of the existing duplicate. */
  readonly duplicateOf?: MemoryRecordId | undefined;
  /** Jaccard similarity score when a duplicate was found. */
  readonly similarity?: number | undefined;
}

/** Configuration for creating a MemoryStore. */
export interface MemoryStoreConfig {
  /** Resolved absolute path to the memory directory. */
  readonly dir: string;
  /** Jaccard similarity threshold for dedup (default 0.7). */
  readonly dedupThreshold?: number | undefined;
}

/** Default dedup threshold — matches v1 behavior. */
export const DEFAULT_DEDUP_THRESHOLD = 0.7;

/**
 * File-based memory store — CRUD operations on memory records.
 *
 * Each record is a Markdown file with bespoke frontmatter.
 * A MEMORY.md index is rebuilt on every mutation.
 */
export interface MemoryStore {
  readonly read: (id: MemoryRecordId) => Promise<MemoryRecord | undefined>;
  readonly write: (input: MemoryRecordInput) => Promise<DedupResult>;
  readonly update: (id: MemoryRecordId, patch: MemoryRecordPatch) => Promise<MemoryRecord>;
  readonly delete: (id: MemoryRecordId) => Promise<boolean>;
  readonly list: (filter?: MemoryListFilter) => Promise<readonly MemoryRecord[]>;
}

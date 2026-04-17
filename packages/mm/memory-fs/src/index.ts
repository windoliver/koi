/**
 * @koi/memory-fs — File-based memory storage with CRUD, indexing, and dedup.
 *
 * L2 package. Depends only on @koi/core.
 */

export { findDuplicate, jaccard, tokenize } from "./dedup.js";
export { readIndex, rebuildIndex } from "./index-file.js";
export type {
  MemoryDirMode,
  ResolvedMemoryDir,
  ResolveMemoryDirOptions,
} from "./resolve-dir.js";
export {
  MemoryPolicyMismatch,
  MemoryResolutionError,
  resolveMemoryDir,
} from "./resolve-dir.js";
export { deriveFilename, slugifyMemoryName } from "./slug.js";
export { createMemoryStore } from "./store.js";
export type {
  DedupResult,
  DeleteResult,
  IndexErrorCallback,
  MemoryListFilter,
  MemoryStore,
  MemoryStoreConfig,
  MemoryStoreOperation,
  UpdateResult,
  UpsertResult,
} from "./types.js";
export { DEFAULT_DEDUP_THRESHOLD } from "./types.js";

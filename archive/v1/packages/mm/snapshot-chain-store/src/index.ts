/**
 * @koi/snapshot-chain-store — SnapshotChainStore implementations (L2).
 *
 * Provides in-memory (and future SQLite/filesystem) backends for the
 * generic SnapshotChainStore<T> interface defined in @koi/core.
 */
export { createInMemorySnapshotChainStore } from "./memory-store.js";
export { createSqliteSnapshotChainStore } from "./sqlite-store.js";
export type { CreateThreadStoreConfig } from "./thread-store.js";
export { createThreadStore } from "./thread-store.js";

/**
 * @koi/snapshot-store-sqlite — SQLite-backed SnapshotChainStore<T> (L0u).
 *
 * Provides durable, WAL-mode storage for snapshot chains with full DAG
 * topology, content-hash dedup, ancestor walking, forking, and pruning.
 */
export { createSqliteSnapshotStore } from "./sqlite-store.js";
export type { SqliteSnapshotStoreConfig } from "./types.js";

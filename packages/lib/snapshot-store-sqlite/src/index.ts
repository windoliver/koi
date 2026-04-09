/**
 * @koi/snapshot-store-sqlite — L2 storage adapter implementing
 * `SnapshotChainStore<T>` from `@koi/core` over SQLite.
 *
 * Spec: docs/L2/snapshot-store-sqlite.md
 */

export type { SqliteSnapshotStore } from "./sqlite-store.js";
export { createSnapshotStoreSqlite } from "./sqlite-store.js";
export type { SqliteSnapshotStoreConfig } from "./types.js";

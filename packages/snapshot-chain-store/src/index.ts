/**
 * @koi/snapshot-chain-store — SnapshotChainStore implementations (L2).
 *
 * Provides in-memory (and future SQLite/filesystem) backends for the
 * generic SnapshotChainStore<T> interface defined in @koi/core.
 */
export { createInMemorySnapshotChainStore } from "./memory-store.js";

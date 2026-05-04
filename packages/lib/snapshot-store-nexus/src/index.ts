/**
 * @koi/snapshot-store-nexus — Nexus-backed `SnapshotChainStore<T>`.
 *
 * L2 storage adapter with the same generic interface as `@koi/snapshot-store-sqlite`.
 *
 * Spec: docs/L2/snapshot-store-nexus.md
 */

export { createSnapshotStoreNexus } from "./nexus-store.js";
export type { NexusSnapshotStoreConfig } from "./types.js";

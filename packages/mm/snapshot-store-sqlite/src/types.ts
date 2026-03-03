/**
 * Configuration types for the SQLite-backed SnapshotChainStore.
 */

/** Configuration for createSqliteSnapshotStore. */
export interface SqliteSnapshotStoreConfig {
  /** Path to the SQLite database file. Use ":memory:" for tests. */
  readonly dbPath: string;
  /**
   * Durability mode — controls PRAGMA synchronous.
   * - "process": NORMAL — durable against process crashes (default)
   * - "os": FULL — durable against OS/power crashes
   */
  readonly durability?: "process" | "os" | undefined;
  /** Table name for snapshot nodes. Default: "snapshot_nodes". Allows multiple stores per DB. */
  readonly tableName?: string | undefined;
}

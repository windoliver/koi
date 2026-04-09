/**
 * SQLite schema and PRAGMAs for the snapshot store.
 *
 * Three tables:
 * - `snapshot_nodes`: immutable DAG nodes; `parent_ids` is a JSON array so the
 *   recursive CTE in `cte.ts` can walk parents with a single query.
 * - `chain_members`: bridge table — a single node can belong to multiple
 *   chains via fork. The `seq` column is a per-chain monotonic counter for
 *   deterministic ordering within the same millisecond.
 * - `chain_heads`: O(1) head pointer per chain.
 *
 * The `chain_id` column on `snapshot_nodes` records the *home* chain (the
 * chain a node was originally `put` into). It is what `get()` returns in
 * `SnapshotNode<T>.chainId` and never changes after creation, even when the
 * node is forked into other chains.
 */

import type { Database } from "bun:sqlite";

/**
 * Apply the schema to a database. Idempotent — uses `CREATE TABLE IF NOT EXISTS`.
 */
export function applySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshot_nodes (
      node_id      TEXT PRIMARY KEY,
      chain_id     TEXT NOT NULL,
      parent_ids   TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      data         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      metadata     TEXT NOT NULL DEFAULT '{}'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chain_members (
      chain_id   TEXT NOT NULL,
      node_id    TEXT NOT NULL REFERENCES snapshot_nodes(node_id),
      created_at INTEGER NOT NULL,
      seq        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain_id, node_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chain_heads (
      chain_id TEXT PRIMARY KEY,
      node_id  TEXT NOT NULL REFERENCES snapshot_nodes(node_id)
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_snapshot_nodes_chain ON snapshot_nodes(chain_id)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_chain_members_chain ON chain_members(chain_id, created_at DESC, seq DESC)",
  );
}

/**
 * Apply pragmas. WAL mode is required for concurrent reads + GC sweeps.
 */
export function applyPragmas(db: Database, durability: "process" | "os"): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA wal_autocheckpoint = 1000");
  if (durability === "os") {
    db.run("PRAGMA synchronous = FULL");
  } else {
    db.run("PRAGMA synchronous = NORMAL");
  }
}

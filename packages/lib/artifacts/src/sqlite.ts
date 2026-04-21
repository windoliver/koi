/**
 * SQLite connection management for @koi/artifacts.
 *
 * openDatabase(config) returns a configured Database instance with WAL mode
 * and the appropriate synchronous level for the durability setting. Applies
 * the full schema at open time (idempotent CREATE TABLE IF NOT EXISTS) and
 * runs in-place ALTER TABLE migrations for columns that were added after an
 * older iteration of the schema.
 */

import { Database } from "bun:sqlite";
import { ALL_DDL } from "./schema.js";
import type { ArtifactStoreConfig } from "./types.js";

interface ColumnInfo {
  readonly name: string;
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as ReadonlyArray<ColumnInfo>;
  return rows.some((r) => r.name === column);
}

function runMigrations(db: Database): void {
  // `pending_blob_puts.artifact_id` added after the initial Plan 2 schema.
  // Any existing DB created between the first pending_blob_puts creation
  // and this migration will lack the column. Add it in-place before the
  // fresh DDL tries to create an index on it.
  if (
    tableHasColumn(db, "pending_blob_puts", "intent_id") &&
    !tableHasColumn(db, "pending_blob_puts", "artifact_id")
  ) {
    db.exec("ALTER TABLE pending_blob_puts ADD COLUMN artifact_id TEXT");
  }
}

export function openDatabase(config: Pick<ArtifactStoreConfig, "dbPath" | "durability">): Database {
  const db = new Database(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA synchronous = ${config.durability === "os" ? "FULL" : "NORMAL"};`);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  // Run in-place migrations BEFORE applying the fresh DDL so ALTER TABLE can
  // add columns that the fresh DDL's CREATE INDEX depends on.
  runMigrations(db);
  for (const ddl of ALL_DDL) {
    db.exec(ddl);
  }
  return db;
}

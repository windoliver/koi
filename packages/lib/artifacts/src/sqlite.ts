/**
 * SQLite connection management for @koi/artifacts.
 *
 * openDatabase(config) returns a configured Database instance with WAL mode
 * and the appropriate synchronous level for the durability setting. Applies
 * the full schema at open time (idempotent CREATE TABLE IF NOT EXISTS).
 */

import { Database } from "bun:sqlite";
import { ALL_DDL } from "./schema.js";
import type { ArtifactStoreConfig } from "./types.js";

export function openDatabase(config: Pick<ArtifactStoreConfig, "dbPath" | "durability">): Database {
  const db = new Database(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA synchronous = ${config.durability === "os" ? "FULL" : "NORMAL"};`);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  for (const ddl of ALL_DDL) {
    db.exec(ddl);
  }
  return db;
}

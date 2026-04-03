/**
 * Shared SQLite database opener with optimized PRAGMAs.
 *
 * Configures WAL mode, synchronous=NORMAL, foreign keys, busy timeout,
 * cache size, and temp storage for optimal single-node performance.
 */

import { Database } from "bun:sqlite";

/** Create a Database with optimized PRAGMAs for Koi stores. */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA cache_size = -16000");
  db.run("PRAGMA temp_store = MEMORY");
  return db;
}

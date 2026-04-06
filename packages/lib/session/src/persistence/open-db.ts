/**
 * Inline SQLite helper — opens a WAL-mode database.
 *
 * Inlined rather than extracted to @koi/sqlite-utils per KISS/Rule-of-Three:
 * only @koi/session needs SQLite today. Extract when a second consumer appears.
 */

import { Database } from "bun:sqlite";

/**
 * Open a SQLite database with WAL mode for crash durability.
 *
 * @param path - File path, or ":memory:" for in-process testing
 * @param durability - "process" (NORMAL sync) or "os" (FULL sync, power-crash safe)
 */
export function openDb(path: string, durability: "process" | "os" = "process"): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`PRAGMA synchronous = ${durability === "os" ? "FULL" : "NORMAL"}`);
  if (durability === "os") {
    // macOS: fsync does not flush disk hardware buffers; fullfsync uses F_FULLFSYNC.
    // No-op on Linux/Windows. Required for true power-loss durability in WAL+FULL mode.
    db.run("PRAGMA fullfsync = 1");
  }
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

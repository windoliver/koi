/**
 * @koi/store-sqlite — SQLite-backed ForgeStore for single-node / CLI usage.
 *
 * Uses bun:sqlite with WAL mode, STRICT tables, and parameterized queries.
 * Depends on @koi/core (L0) and @koi/validation (L2) only.
 */

export type { SqliteForgeStore, SqliteForgeStoreConfig } from "./sqlite-store.js";
export { createSqliteForgeStore, openForgeDb } from "./sqlite-store.js";

/**
 * @koi/sqlite-utils — Shared SQLite utilities for Koi stores (L0u).
 *
 * Error mapping, result wrapping, and database opener with optimized PRAGMAs.
 */
export { mapSqliteError, wrapSqlite } from "./errors.js";
export { openDb } from "./open-db.js";

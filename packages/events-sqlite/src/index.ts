/**
 * @koi/events-sqlite — SQLite-backed EventBackend (Layer 2).
 *
 * Durable event persistence using bun:sqlite with WAL mode, crash recovery
 * via replay, FIFO/TTL eviction, and dead letter queue.
 */
export type { SqliteEventBackendConfig } from "./sqlite-backend.js";
export { createSqliteEventBackend } from "./sqlite-backend.js";

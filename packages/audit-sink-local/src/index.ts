/**
 * @koi/audit-sink-local — Local audit sink implementations (Layer 2).
 *
 * Provides SQLite-backed and NDJSON file audit sinks for offline operation.
 */

export { createNdjsonAuditSink } from "./ndjson-sink.js";
export { createSqliteAuditSink } from "./sqlite-sink.js";
export type { NdjsonAuditSinkConfig, SqliteAuditSinkConfig } from "./types.js";

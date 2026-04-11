/**
 * @koi/audit-sink-sqlite — SQLite sink with WAL mode for @koi/middleware-audit.
 */

export type { SqliteAuditSinkConfig } from "./config.js";
export { validateSqliteAuditSinkConfig } from "./config.js";
export { createSqliteAuditSink } from "./sqlite-sink.js";

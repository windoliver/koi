/**
 * @koi/audit-sink-ndjson — Buffered NDJSON file sink for @koi/middleware-audit.
 */

export type { NdjsonAuditSinkConfig } from "./config.js";
export { validateNdjsonAuditSinkConfig } from "./config.js";
export { createNdjsonAuditSink } from "./ndjson-sink.js";

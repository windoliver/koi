/**
 * @koi/middleware-audit — Compliance logging and PII redaction (Layer 2)
 *
 * Logs every model/tool call with structured audit entries.
 * Supports PII redaction and payload truncation.
 * Depends on @koi/core only.
 */

export type { AuditEntry, AuditSink, RedactionRule } from "@koi/core";
export { createAuditMiddleware } from "./audit.js";
export type { AuditMiddlewareConfig } from "./config.js";
export { validateAuditConfig } from "./config.js";
export {
  applyRedaction,
  createConsoleAuditSink,
  createInMemoryAuditSink,
  truncate,
} from "./sink.js";

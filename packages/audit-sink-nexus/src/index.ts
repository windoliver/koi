/**
 * @koi/audit-sink-nexus — Nexus-backed AuditSink with batched writes (Layer 2).
 *
 * Implements the AuditSink contract from @koi/core, persisting structured
 * audit entries to Nexus via JSON-RPC. Supports configurable batch size,
 * flush interval, and retry policy.
 */

// Re-export core types for consumer convenience
export type { AuditEntry, AuditSink } from "@koi/core";

// Config
export type { NexusAuditSinkConfig } from "./config.js";
export {
  DEFAULT_BASE_PATH,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  validateNexusAuditSinkConfig,
} from "./config.js";

// Factory
export { createNexusAuditSink } from "./nexus-sink.js";

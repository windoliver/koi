/**
 * Configuration types for local audit sinks.
 */

import type { RedactionRule } from "@koi/core";

/** Configuration for the SQLite-backed audit sink. */
export interface SqliteAuditSinkConfig {
  /** SQLite database path (e.g., ":memory:" or "/tmp/audit.db"). */
  readonly dbPath: string;
  /** Flush interval in milliseconds. Default: 2000. */
  readonly flushIntervalMs?: number | undefined;
  /** Maximum entries to buffer before auto-flush. Default: 100. */
  readonly maxBufferSize?: number | undefined;
  /** Redaction rules applied before writing. */
  readonly redactionRules?: readonly RedactionRule[] | undefined;
}

/** Configuration for the NDJSON file audit sink. */
export interface NdjsonAuditSinkConfig {
  /** File path for the NDJSON output. */
  readonly filePath: string;
  /** Redaction rules applied before writing. */
  readonly redactionRules?: readonly RedactionRule[] | undefined;
}

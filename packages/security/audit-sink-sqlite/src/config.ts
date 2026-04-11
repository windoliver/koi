/**
 * Configuration for @koi/audit-sink-sqlite.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

export interface SqliteAuditSinkConfig {
  /** Path to the SQLite database file. Use ":memory:" for in-memory (tests). */
  readonly dbPath: string;
  /** Flush interval in milliseconds. Default: 2000. */
  readonly flushIntervalMs?: number;
  /** Maximum buffer size before an automatic flush. Default: 100. */
  readonly maxBufferSize?: number;
}

function fail(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validateSqliteAuditSinkConfig(
  config: unknown,
): Result<SqliteAuditSinkConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return fail("config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (typeof c.dbPath !== "string" || c.dbPath.length === 0) {
    return fail("config.dbPath must be a non-empty string");
  }

  if (c.flushIntervalMs !== undefined) {
    if (typeof c.flushIntervalMs !== "number" || c.flushIntervalMs <= 0) {
      return fail("config.flushIntervalMs must be a positive number");
    }
  }

  if (c.maxBufferSize !== undefined) {
    if (typeof c.maxBufferSize !== "number" || c.maxBufferSize <= 0) {
      return fail("config.maxBufferSize must be a positive number");
    }
  }

  return { ok: true, value: config as SqliteAuditSinkConfig };
}

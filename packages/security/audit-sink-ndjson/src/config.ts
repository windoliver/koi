/**
 * Configuration for @koi/audit-sink-ndjson.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

export interface NdjsonAuditSinkConfig {
  /** Absolute or relative path to the NDJSON output file. */
  readonly filePath: string;
  /** Flush interval in milliseconds. Default: 2000. */
  readonly flushIntervalMs?: number;
}

function fail(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validateNdjsonAuditSinkConfig(
  config: unknown,
): Result<NdjsonAuditSinkConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return fail("config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (typeof c.filePath !== "string" || c.filePath.length === 0) {
    return fail("config.filePath must be a non-empty string");
  }

  if (c.flushIntervalMs !== undefined) {
    if (typeof c.flushIntervalMs !== "number" || c.flushIntervalMs <= 0) {
      return fail("config.flushIntervalMs must be a positive number");
    }
  }

  return { ok: true, value: config as NdjsonAuditSinkConfig };
}

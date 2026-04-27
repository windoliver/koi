/**
 * Configuration for @koi/audit-sink-ndjson.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

export interface NdjsonRotationConfig {
  /** Rotate when the active file exceeds this many bytes. No limit if omitted. */
  readonly maxSizeBytes?: number;
  /** Rotate at UTC day boundary. Default: false. */
  readonly daily?: boolean;
}

export interface NdjsonAuditSinkConfig {
  /** Absolute or relative path to the NDJSON output file. */
  readonly filePath: string;
  /** Flush interval in milliseconds. Default: 2000. */
  readonly flushIntervalMs?: number;
  /** Log rotation policy. Omit to disable rotation. */
  readonly rotation?: NdjsonRotationConfig;
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

  if (c.rotation !== undefined) {
    if (typeof c.rotation !== "object" || c.rotation === null) {
      return fail("config.rotation must be an object");
    }
    const r = c.rotation as Record<string, unknown>;
    if (r.maxSizeBytes !== undefined) {
      if (typeof r.maxSizeBytes !== "number" || r.maxSizeBytes <= 0) {
        return fail("config.rotation.maxSizeBytes must be a positive number");
      }
    }
    if (r.daily !== undefined && typeof r.daily !== "boolean") {
      return fail("config.rotation.daily must be a boolean");
    }
  }

  return { ok: true, value: config as NdjsonAuditSinkConfig };
}

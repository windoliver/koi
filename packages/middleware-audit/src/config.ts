/**
 * Audit middleware configuration and validation.
 */

import type { AuditEntry, AuditSink, RedactionRule } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

export interface AuditMiddlewareConfig {
  readonly sink: AuditSink;
  readonly redactionRules?: readonly RedactionRule[];
  readonly redactRequestBodies?: boolean;
  readonly maxEntrySize?: number;
  readonly onError?: (error: unknown, entry: AuditEntry) => void;
}

export function validateConfig(config: unknown): Result<AuditMiddlewareConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (!c.sink || typeof c.sink !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'sink' with a 'log' method",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.maxEntrySize !== undefined) {
    if (typeof c.maxEntrySize !== "number" || c.maxEntrySize <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxEntrySize must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as AuditMiddlewareConfig };
}

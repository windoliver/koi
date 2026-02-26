/**
 * Permissions middleware configuration and validation.
 */

import type { AuditSink } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { PermissionBackend } from "@koi/core/permission-backend";
import type { CircuitBreakerConfig } from "@koi/errors";
import type { ApprovalHandler } from "./engine.js";

export interface PermissionCacheConfig {
  readonly allowTtlMs?: number;
  readonly denyTtlMs?: number;
  readonly maxEntries?: number;
  /** Time-to-live in ms for cached approvals. 0 = no expiry. Default: 300_000 (5 min). */
  readonly ttlMs?: number;
}

/** Default max entries for the approval (ask) cache. */
export const DEFAULT_APPROVAL_CACHE_MAX_ENTRIES = 256;
/** Default approval cache TTL: 5 minutes. Prevents stale authorizations surviving policy or identity changes. */
export const DEFAULT_APPROVAL_CACHE_TTL_MS = 300_000;

/** Default config for the decision (allow/deny) cache. */
export const DEFAULT_CACHE_CONFIG = {
  allowTtlMs: 300_000,
  denyTtlMs: 10_000,
  maxEntries: 1024,
} as const;

export interface PermissionsMiddlewareConfig {
  readonly backend: PermissionBackend;
  readonly approvalHandler?: ApprovalHandler;
  readonly approvalTimeoutMs?: number;
  readonly cache?: boolean | PermissionCacheConfig;
  readonly description?: string;
  readonly clock?: () => number;
  readonly auditSink?: AuditSink;
  readonly circuitBreaker?: CircuitBreakerConfig;
}

export function validatePermissionsConfig(
  config: unknown,
): Result<PermissionsMiddlewareConfig, KoiError> {
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

  if (
    !c.backend ||
    typeof c.backend !== "object" ||
    !("check" in c.backend) ||
    typeof (c.backend as Record<string, unknown>).check !== "function"
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'backend' with a 'check' method",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.approvalTimeoutMs !== undefined) {
    if (typeof c.approvalTimeoutMs !== "number" || c.approvalTimeoutMs <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "approvalTimeoutMs must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.cache !== undefined && c.cache !== false && c.cache !== true) {
    if (typeof c.cache !== "object" || c.cache === null) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "cache must be a boolean or a PermissionCacheConfig object",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    const cache = c.cache as Record<string, unknown>;
    if (cache.maxEntries !== undefined) {
      if (typeof cache.maxEntries !== "number" || cache.maxEntries <= 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "cache.maxEntries must be a positive number",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
    if (cache.allowTtlMs !== undefined) {
      if (typeof cache.allowTtlMs !== "number" || cache.allowTtlMs <= 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "cache.allowTtlMs must be a positive number",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
    if (cache.denyTtlMs !== undefined) {
      if (typeof cache.denyTtlMs !== "number" || cache.denyTtlMs <= 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "cache.denyTtlMs must be a positive number",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
    if (cache.ttlMs !== undefined) {
      if (typeof cache.ttlMs !== "number" || cache.ttlMs < 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "approvalCache.ttlMs must be a non-negative number",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  if (c.auditSink !== undefined) {
    if (
      typeof c.auditSink !== "object" ||
      c.auditSink === null ||
      typeof (c.auditSink as Record<string, unknown>).log !== "function"
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "auditSink must be an object with a 'log' method",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.circuitBreaker !== undefined) {
    if (typeof c.circuitBreaker !== "object" || c.circuitBreaker === null) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "circuitBreaker must be a CircuitBreakerConfig object",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    const cb = c.circuitBreaker as Record<string, unknown>;
    if (
      typeof cb.failureThreshold !== "number" ||
      cb.failureThreshold <= 0 ||
      typeof cb.cooldownMs !== "number" ||
      cb.cooldownMs <= 0 ||
      typeof cb.failureWindowMs !== "number" ||
      cb.failureWindowMs <= 0
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            "circuitBreaker requires positive failureThreshold, cooldownMs, and failureWindowMs",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as PermissionsMiddlewareConfig };
}

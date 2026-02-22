/**
 * Permissions middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ApprovalHandler, PermissionEngine, PermissionRules } from "./engine.js";

export interface PermissionsMiddlewareConfig {
  readonly engine: PermissionEngine;
  readonly rules: PermissionRules;
  readonly approvalHandler?: ApprovalHandler;
  readonly approvalTimeoutMs?: number;
  readonly defaultDeny?: boolean;
}

export function validateConfig(config: unknown): Result<PermissionsMiddlewareConfig, KoiError> {
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

  if (!c.engine || typeof c.engine !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires an 'engine' with a 'check' method",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (!c.rules || typeof c.rules !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires 'rules' with allow, deny, and ask arrays",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const rules = c.rules as Record<string, unknown>;
  if (!Array.isArray(rules.allow) || !Array.isArray(rules.deny) || !Array.isArray(rules.ask)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Rules must contain 'allow', 'deny', and 'ask' arrays",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // If ask rules exist, approvalHandler is required
  if ((rules.ask as readonly unknown[]).length > 0 && !c.approvalHandler) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "approvalHandler is required when 'ask' rules are defined",
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

  return { ok: true, value: config as PermissionsMiddlewareConfig };
}

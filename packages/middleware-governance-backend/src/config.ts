/**
 * GovernanceBackendMiddlewareConfig interface and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type {
  GovernanceBackend,
  GovernanceBackendEvent,
  GovernanceVerdict,
} from "@koi/core/governance-backend";

export interface GovernanceBackendMiddlewareConfig {
  readonly backend: GovernanceBackend;
  readonly onViolation?: (verdict: GovernanceVerdict, event: GovernanceBackendEvent) => void;
}

export function validateGovernanceBackendConfig(
  config: unknown,
): Result<GovernanceBackendMiddlewareConfig, KoiError> {
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
    !("evaluate" in c.backend) ||
    typeof (c.backend as Record<string, unknown>).evaluate !== "function"
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'backend' with an 'evaluate' method",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.onViolation !== undefined && typeof c.onViolation !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "onViolation must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: config as GovernanceBackendMiddlewareConfig };
}

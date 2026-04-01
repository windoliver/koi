/**
 * PII middleware configuration validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { PIIConfig, PIIStrategy } from "./types.js";

const VALID_STRATEGIES = new Set<string>(["block", "redact", "mask", "hash"]);

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validatePIIConfig(config: unknown): Result<PIIConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (typeof c.strategy !== "string" || !VALID_STRATEGIES.has(c.strategy)) {
    return validationError(`strategy must be one of: ${[...VALID_STRATEGIES].join(", ")}`);
  }

  const strategy = c.strategy as PIIStrategy;

  if (strategy === "hash" && (typeof c.hashSecret !== "string" || c.hashSecret.length === 0)) {
    return validationError("hashSecret is required when strategy is 'hash'");
  }

  if (c.detectors !== undefined && !Array.isArray(c.detectors)) {
    return validationError("detectors must be an array");
  }

  if (c.customDetectors !== undefined && !Array.isArray(c.customDetectors)) {
    return validationError("customDetectors must be an array");
  }

  if (c.scope !== undefined) {
    if (typeof c.scope !== "object" || c.scope === null) {
      return validationError("scope must be a non-null object");
    }
  }

  if (c.onDetection !== undefined && typeof c.onDetection !== "function") {
    return validationError("onDetection must be a function");
  }

  return { ok: true, value: config as PIIConfig };
}

/**
 * Config validation for Nexus search adapter.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { NexusSearchConfig } from "./nexus-search-config.js";

function validationError(message: string): Result<void, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

export function validateNexusSearchConfig(config: NexusSearchConfig): Result<void, KoiError> {
  if (config.baseUrl.trim().length === 0) {
    return validationError("baseUrl must not be empty");
  }

  try {
    new URL(config.baseUrl);
  } catch {
    return validationError("baseUrl must be a valid URL");
  }

  if (config.apiKey.trim().length === 0) {
    return validationError("apiKey must not be empty");
  }

  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    return validationError("timeoutMs must be positive");
  }

  if (config.defaultLimit !== undefined && config.defaultLimit <= 0) {
    return validationError("defaultLimit must be positive");
  }

  if (config.minScore !== undefined && (config.minScore < 0 || config.minScore > 1)) {
    return validationError("minScore must be between 0 and 1");
  }

  if (config.maxBatchSize !== undefined && config.maxBatchSize <= 0) {
    return validationError("maxBatchSize must be positive");
  }

  return { ok: true, value: undefined };
}

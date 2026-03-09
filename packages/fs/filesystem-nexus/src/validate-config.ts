/**
 * Manual validation for NexusFileSystemConfig.
 *
 * Returns Result<NexusFileSystemConfig, KoiError> — no throwing.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { NexusFileSystemConfig } from "./types.js";

export function validateNexusFileSystemConfig(
  config: NexusFileSystemConfig,
): Result<NexusFileSystemConfig, KoiError> {
  if (config.client === undefined || config.client === null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusFileSystemConfig.client is required",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (config.basePath !== undefined) {
    if (config.basePath === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.basePath must be non-empty when provided",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    // NexusPath convention: no leading slash, no ".." (#922)
    if (config.basePath.includes("..")) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.basePath must not contain '..'",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config };
}

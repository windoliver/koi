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
  if (config.transport === undefined || config.transport === null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusFileSystemConfig.transport is required",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (typeof config.transport.call !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusFileSystemConfig.transport.call must be a function",
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
          message: "NexusFileSystemConfig.basePath must not be empty (omit for default)",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
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

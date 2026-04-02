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
    // Normalize basePath with the same rules as user paths before validation:
    // decode percent-encoding, normalize backslashes to forward slashes,
    // strip leading slashes. This ensures encoded traversal forms like
    // "safe%2F..%2Fother" or "safe\\..\\other" are caught.
    let decoded: string;
    try {
      decoded = decodeURIComponent(config.basePath.replace(/\\/g, "/"));
    } catch {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.basePath contains malformed percent-encoding",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    const normalized = decoded.replace(/^\/+/, "");
    if (normalized === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            "NexusFileSystemConfig.basePath must not be empty or root-only (omit for default)",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    if (normalized.includes("..")) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.basePath must not contain '..' (after normalization)",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    // Return config with canonicalized basePath so the factory uses the
    // same normalized form for RPC routing, scope checks, and response stripping.
    return {
      ok: true,
      value: { ...config, basePath: normalized },
    };
  }

  return { ok: true, value: config };
}

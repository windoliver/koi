/**
 * Config validation for NexusFileSystemConfig.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { NexusFileSystemConfig } from "./types.js";

/** Validate NexusFileSystemConfig at the system boundary. */
export function validateNexusFileSystemConfig(
  config: unknown,
): Result<NexusFileSystemConfig, KoiError> {
  if (typeof config !== "object" || config === null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusFileSystemConfig must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (typeof c.url !== "string" || c.url.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusFileSystemConfig.url must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Only HTTP(S) URLs are supported by the HTTP transport.
  // Unix socket transport is not implemented.
  if (!c.url.startsWith("http://") && !c.url.startsWith("https://")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `NexusFileSystemConfig.url must use http:// or https:// scheme, got: "${c.url.split("://")[0] ?? "unknown"}://"`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.mountPoint !== undefined) {
    if (typeof c.mountPoint !== "string") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.mountPoint must be a string",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    // Reject empty or root mount — prevents addressing the entire Nexus namespace
    const stripped = c.mountPoint.replace(/^\/+/, "").replace(/\/+$/, "");
    if (stripped.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            "NexusFileSystemConfig.mountPoint must be a non-empty namespace prefix (e.g., 'fs', 'workspace/agent1')",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    if (c.mountPoint.includes("..")) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.mountPoint must not contain '..'",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.deadlineMs !== undefined) {
    if (typeof c.deadlineMs !== "number" || c.deadlineMs <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.deadlineMs must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.retries !== undefined) {
    if (typeof c.retries !== "number" || c.retries < 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "NexusFileSystemConfig.retries must be a non-negative number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as NexusFileSystemConfig };
}

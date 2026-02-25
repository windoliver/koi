/**
 * Manual config validation for ExternalAdapterConfig.
 *
 * Returns Result<T, KoiError> — never throws.
 * Follows the pattern from packages/trust-router/src/config.ts.
 */

import type { KoiError, Result } from "@koi/core";
import type { ExternalAdapterConfig } from "./types.js";

/**
 * Validate an ExternalAdapterConfig from untrusted input.
 */
export function validateExternalAdapterConfig(
  config: unknown,
): Result<ExternalAdapterConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ExternalAdapterConfig must be a non-null object",
        retryable: false,
      },
    };
  }

  const c = config as Record<string, unknown>;

  // command: required non-empty string
  if (typeof c.command !== "string" || c.command.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ExternalAdapterConfig.command must be a non-empty string",
        retryable: false,
      },
    };
  }

  // args: optional string array
  if (c.args !== undefined) {
    if (!Array.isArray(c.args) || !c.args.every((a: unknown) => typeof a === "string")) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "ExternalAdapterConfig.args must be an array of strings",
          retryable: false,
        },
      };
    }
  }

  // timeoutMs: optional non-negative number
  if (c.timeoutMs !== undefined) {
    if (typeof c.timeoutMs !== "number" || c.timeoutMs < 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "ExternalAdapterConfig.timeoutMs must be a non-negative number",
          retryable: false,
        },
      };
    }
  }

  // noOutputTimeoutMs: optional non-negative number
  if (c.noOutputTimeoutMs !== undefined) {
    if (typeof c.noOutputTimeoutMs !== "number" || c.noOutputTimeoutMs < 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "ExternalAdapterConfig.noOutputTimeoutMs must be a non-negative number",
          retryable: false,
        },
      };
    }
  }

  // maxOutputBytes: optional positive number
  if (c.maxOutputBytes !== undefined) {
    if (typeof c.maxOutputBytes !== "number" || c.maxOutputBytes <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "ExternalAdapterConfig.maxOutputBytes must be a positive number",
          retryable: false,
        },
      };
    }
  }

  // mode: optional "single-shot" | "long-lived"
  if (c.mode !== undefined) {
    if (c.mode !== "single-shot" && c.mode !== "long-lived") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: 'ExternalAdapterConfig.mode must be "single-shot" or "long-lived"',
          retryable: false,
        },
      };
    }
  }

  // shutdown.gracePeriodMs: optional non-negative number
  if (c.shutdown !== undefined) {
    if (typeof c.shutdown !== "object" || c.shutdown === null) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "ExternalAdapterConfig.shutdown must be an object",
          retryable: false,
        },
      };
    }
    const s = c.shutdown as Record<string, unknown>;
    if (s.gracePeriodMs !== undefined) {
      if (typeof s.gracePeriodMs !== "number" || s.gracePeriodMs < 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "ExternalAdapterConfig.shutdown.gracePeriodMs must be a non-negative number",
            retryable: false,
          },
        };
      }
    }
  }

  return { ok: true, value: config as ExternalAdapterConfig };
}

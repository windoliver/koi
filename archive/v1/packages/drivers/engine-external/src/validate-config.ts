/**
 * Manual config validation for ExternalAdapterConfig.
 *
 * Returns Result<T, KoiError> — never throws.
 * Follows the pattern from packages/trust-router/src/config.ts.
 */

import type { KoiError, Result } from "@koi/core";
import type { ExternalAdapterConfig } from "./types.js";

/** Max length for prompt regex patterns to mitigate ReDoS from untrusted input. */
const MAX_PROMPT_PATTERN_LENGTH = 256 as const;

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

  // mode: optional "single-shot" | "long-lived" | "pty"
  if (c.mode !== undefined) {
    if (c.mode !== "single-shot" && c.mode !== "long-lived" && c.mode !== "pty") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: 'ExternalAdapterConfig.mode must be "single-shot", "long-lived", or "pty"',
          retryable: false,
        },
      };
    }
  }

  // pty: optional PtyConfig object
  if (c.pty !== undefined) {
    if (typeof c.pty !== "object" || c.pty === null) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "ExternalAdapterConfig.pty must be an object",
          retryable: false,
        },
      };
    }
    const p = c.pty as Record<string, unknown>;

    if (p.idleThresholdMs !== undefined) {
      if (typeof p.idleThresholdMs !== "number" || p.idleThresholdMs <= 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "ExternalAdapterConfig.pty.idleThresholdMs must be a positive number",
            retryable: false,
          },
        };
      }
    }

    if (p.ansiStrip !== undefined) {
      if (typeof p.ansiStrip !== "boolean") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "ExternalAdapterConfig.pty.ansiStrip must be a boolean",
            retryable: false,
          },
        };
      }
    }

    if (p.cols !== undefined) {
      if (typeof p.cols !== "number" || p.cols <= 0 || !Number.isInteger(p.cols)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "ExternalAdapterConfig.pty.cols must be a positive integer",
            retryable: false,
          },
        };
      }
    }

    if (p.rows !== undefined) {
      if (typeof p.rows !== "number" || p.rows <= 0 || !Number.isInteger(p.rows)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "ExternalAdapterConfig.pty.rows must be a positive integer",
            retryable: false,
          },
        };
      }
    }

    if (p.promptPattern !== undefined) {
      if (typeof p.promptPattern !== "string") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "ExternalAdapterConfig.pty.promptPattern must be a string",
            retryable: false,
          },
        };
      }
      // Length limit to mitigate ReDoS from overly complex patterns
      if (p.promptPattern.length > MAX_PROMPT_PATTERN_LENGTH) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `ExternalAdapterConfig.pty.promptPattern exceeds max length of ${MAX_PROMPT_PATTERN_LENGTH} characters`,
            retryable: false,
          },
        };
      }
      // Verify it compiles as a valid regex
      try {
        new RegExp(p.promptPattern);
      } catch {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `ExternalAdapterConfig.pty.promptPattern is not a valid regex: "${p.promptPattern}"`,
            retryable: false,
          },
        };
      }
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

/**
 * BrickDescriptor for @koi/middleware-report.
 *
 * Enables manifest auto-resolution: validates report config,
 * then creates the report middleware with defaults.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createReportMiddleware } from "./report.js";

function validateReportDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Report options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.maxActions !== undefined &&
    (typeof opts.maxActions !== "number" || opts.maxActions <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "report.maxActions must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.summarizerTimeoutMs !== undefined &&
    (typeof opts.summarizerTimeoutMs !== "number" || opts.summarizerTimeoutMs <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "report.summarizerTimeoutMs must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for report middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-report",
  aliases: ["report"],
  optionsValidator: validateReportDescriptorOptions,
  factory(options): KoiMiddleware {
    const objective = typeof options.objective === "string" ? options.objective : undefined;
    const maxActions = typeof options.maxActions === "number" ? options.maxActions : undefined;
    const summarizerTimeoutMs =
      typeof options.summarizerTimeoutMs === "number" ? options.summarizerTimeoutMs : undefined;

    const handle = createReportMiddleware({
      objective,
      maxActions,
      summarizerTimeoutMs,
    });

    return handle.middleware;
  },
};

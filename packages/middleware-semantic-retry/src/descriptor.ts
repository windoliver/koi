/**
 * BrickDescriptor for @koi/middleware-semantic-retry.
 *
 * Enables manifest auto-resolution: validates retry config options,
 * then creates the semantic retry middleware with default analyzer/rewriter.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createSemanticRetryMiddleware } from "./semantic-retry.js";

function validateSemanticRetryDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Semantic retry options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.maxRetries !== undefined &&
    (typeof opts.maxRetries !== "number" || opts.maxRetries <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "semantic-retry.maxRetries must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for semantic-retry middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-semantic-retry",
  aliases: ["semantic-retry"],
  optionsValidator: validateSemanticRetryDescriptorOptions,
  factory(options): KoiMiddleware {
    const maxRetries = typeof options.maxRetries === "number" ? options.maxRetries : undefined;

    const config: Record<string, unknown> = {};
    if (maxRetries !== undefined) {
      (config as { maxRetries: number }).maxRetries = maxRetries;
    }

    const handle = createSemanticRetryMiddleware(
      config as Parameters<typeof createSemanticRetryMiddleware>[0],
    );
    return handle.middleware;
  },
};

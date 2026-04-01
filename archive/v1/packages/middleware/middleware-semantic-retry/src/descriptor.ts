/**
 * BrickDescriptor for @koi/middleware-semantic-retry.
 *
 * Enables manifest auto-resolution: validates retry config options,
 * then creates the semantic retry middleware with default analyzer/rewriter.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createSemanticRetryMiddleware } from "./semantic-retry.js";

function validateSemanticRetryDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Semantic retry");
  if (!base.ok) return base;
  const opts = base.value;

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

  return { ok: true, value: opts };
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
  factory(options: Record<string, unknown>): KoiMiddleware {
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

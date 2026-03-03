/**
 * BrickDescriptor for @koi/middleware-call-dedup.
 *
 * Enables manifest auto-resolution: validates call-dedup options
 * from koi.yaml, then creates the dedup middleware.
 *
 * Usage in koi.yaml:
 *   middleware:
 *     - name: call-dedup
 *       options:
 *         ttlMs: 60000
 *         exclude: [my_custom_mutation_tool]
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createCallDedupMiddleware } from "./call-dedup.js";
import { validateCallDedupConfig } from "./config.js";

function descriptorValidationError(message: string): {
  readonly ok: false;
  readonly error: KoiError;
} {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function validateCallDedupDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return descriptorValidationError("call-dedup options must be an object");
  }

  // Delegate to the config validator for field-level checks
  return validateCallDedupConfig(input);
}

/**
 * Descriptor for call-dedup middleware.
 *
 * Creates a dedup middleware from validated YAML options.
 * Uses in-memory LRU store by default.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-call-dedup",
  aliases: ["call-dedup"],
  description: "Caches identical deterministic tool call results to avoid redundant execution",
  optionsValidator: validateCallDedupDescriptorOptions,
  factory(options): KoiMiddleware {
    const opts = options as Record<string, unknown>;
    return createCallDedupMiddleware({
      ttlMs: typeof opts.ttlMs === "number" ? opts.ttlMs : undefined,
      maxEntries: typeof opts.maxEntries === "number" ? opts.maxEntries : undefined,
      include: Array.isArray(opts.include) ? (opts.include as readonly string[]) : undefined,
      exclude: Array.isArray(opts.exclude) ? (opts.exclude as readonly string[]) : undefined,
    });
  },
};

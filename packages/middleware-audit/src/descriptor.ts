/**
 * BrickDescriptor for @koi/middleware-audit.
 *
 * Enables manifest auto-resolution: validates audit config,
 * then creates the audit middleware with a console sink by default.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createAuditMiddleware } from "./audit.js";
import { createConsoleAuditSink } from "./sink.js";

function validateAuditDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Audit options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.maxEntrySize !== undefined &&
    (typeof opts.maxEntrySize !== "number" || opts.maxEntrySize <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "audit.maxEntrySize must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for audit middleware.
 * Uses a console audit sink by default.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-audit",
  aliases: ["audit"],
  optionsValidator: validateAuditDescriptorOptions,
  factory(options): KoiMiddleware {
    const sink = createConsoleAuditSink();
    const maxEntrySize =
      typeof options.maxEntrySize === "number" ? options.maxEntrySize : undefined;

    const config: Parameters<typeof createAuditMiddleware>[0] = { sink };

    if (maxEntrySize !== undefined) {
      return createAuditMiddleware({ ...config, maxEntrySize });
    }

    return createAuditMiddleware(config);
  },
};

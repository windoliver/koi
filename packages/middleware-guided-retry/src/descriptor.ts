/**
 * BrickDescriptor for @koi/middleware-guided-retry.
 *
 * Enables manifest auto-resolution: validates initial constraint options,
 * then creates the guided retry middleware.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createGuidedRetryMiddleware } from "./guided-retry.js";

function validateGuidedRetryDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Guided retry options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for guided-retry middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-guided-retry",
  aliases: ["guided-retry"],
  optionsValidator: validateGuidedRetryDescriptorOptions,
  factory(): KoiMiddleware {
    const handle = createGuidedRetryMiddleware({});
    return handle.middleware;
  },
};

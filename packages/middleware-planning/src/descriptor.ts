/**
 * BrickDescriptor for @koi/middleware-planning.
 *
 * Enables manifest auto-resolution: validates planning config options,
 * then creates the plan middleware.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createPlanMiddleware } from "./plan-middleware.js";

function validatePlanningDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Planning options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for planning middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-planning",
  aliases: ["planning"],
  optionsValidator: validatePlanningDescriptorOptions,
  factory(): KoiMiddleware {
    return createPlanMiddleware();
  },
};

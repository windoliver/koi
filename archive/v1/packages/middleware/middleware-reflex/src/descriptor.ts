/**
 * BrickDescriptor for @koi/middleware-reflex.
 *
 * Enables manifest auto-resolution: validates reflex options
 * from koi.yaml, then creates the reflex middleware.
 *
 * Usage in koi.yaml:
 *   middleware:
 *     - name: reflex
 *       options:
 *         rules: ...
 */

import type { JsonObject, KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateReflexConfig } from "./config.js";
import { createReflexMiddleware } from "./reflex.js";
import type { ReflexRule } from "./types.js";

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

function validateReflexDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return descriptorValidationError("reflex options must be an object");
  }

  return validateReflexConfig(input);
}

/**
 * Descriptor for reflex middleware.
 *
 * Creates a reflex middleware from validated YAML options.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-reflex",
  aliases: ["reflex"],
  description:
    "Rule-based short-circuit for known message patterns — skips LLM for predictable responses",
  optionsValidator: validateReflexDescriptorOptions,
  factory(options: JsonObject): KoiMiddleware {
    const opts = options as Record<string, unknown>;
    const rules = Array.isArray(opts.rules) ? (opts.rules as unknown as readonly ReflexRule[]) : [];
    return createReflexMiddleware({
      rules,
      enabled: typeof opts.enabled === "boolean" ? opts.enabled : undefined,
    });
  },
};

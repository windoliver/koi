/**
 * BrickDescriptor for @koi/middleware-sanitize.
 *
 * Enables manifest auto-resolution: validates sanitize config,
 * then creates the sanitize middleware with preset-based rules.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import type { SanitizeMiddlewareConfig } from "./config.js";
import { resolvePresets } from "./rules.js";
import { createSanitizeMiddleware } from "./sanitize-middleware.js";
import type { RulePreset } from "./types.js";

const VALID_PRESETS: readonly string[] = [
  "prompt-injection",
  "control-chars",
  "html-tags",
  "zero-width",
];

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateSanitizeDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Sanitize options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (opts.presets !== undefined) {
    if (!isStringArray(opts.presets)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "sanitize.presets must be an array of strings",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    for (const preset of opts.presets) {
      if (!VALID_PRESETS.includes(preset)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `sanitize.presets contains invalid preset "${preset}". Valid: ${VALID_PRESETS.join(", ")}`,
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for sanitize middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-sanitize",
  aliases: ["sanitize"],
  optionsValidator: validateSanitizeDescriptorOptions,
  factory(options): KoiMiddleware {
    const presets = isStringArray(options.presets)
      ? (options.presets as readonly RulePreset[])
      : (["prompt-injection", "control-chars"] as const satisfies readonly RulePreset[]);

    const rules = resolvePresets(presets);

    const config: SanitizeMiddlewareConfig = { rules };

    return createSanitizeMiddleware(config);
  },
};

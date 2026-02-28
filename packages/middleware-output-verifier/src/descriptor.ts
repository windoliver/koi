/**
 * BrickDescriptor for @koi/middleware-output-verifier.
 *
 * Enables manifest auto-resolution: validates verifier config,
 * then creates the output verifier middleware with a nonEmpty deterministic
 * check by default.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { nonEmpty } from "./builtin-checks.js";
import { createOutputVerifierMiddleware } from "./output-verifier.js";
import type { JudgeConfig, VerifierConfig } from "./types.js";

function validateVerifierDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Output verifier options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.vetoThreshold !== undefined &&
    (typeof opts.vetoThreshold !== "number" || opts.vetoThreshold < 0 || opts.vetoThreshold > 1)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "output-verifier.vetoThreshold must be between 0.0 and 1.0",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.samplingRate !== undefined &&
    (typeof opts.samplingRate !== "number" || opts.samplingRate < 0 || opts.samplingRate > 1)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "output-verifier.samplingRate must be between 0.0 and 1.0",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.rubric !== undefined && typeof opts.rubric !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "output-verifier.rubric must be a string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for output verifier middleware.
 * Defaults to a nonEmpty deterministic check when no deterministic checks are provided.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-output-verifier",
  aliases: ["output-verifier"],
  optionsValidator: validateVerifierDescriptorOptions,
  factory(options): KoiMiddleware {
    const rubric = typeof options.rubric === "string" ? options.rubric : undefined;
    const vetoThreshold =
      typeof options.vetoThreshold === "number" ? options.vetoThreshold : undefined;
    const samplingRate =
      typeof options.samplingRate === "number" ? options.samplingRate : undefined;

    const config: VerifierConfig = {
      deterministic: [nonEmpty("block")],
      ...(rubric !== undefined && typeof options.modelCall === "function"
        ? {
            judge: {
              rubric,
              modelCall: options.modelCall as JudgeConfig["modelCall"],
              ...(vetoThreshold !== undefined ? { vetoThreshold } : {}),
              ...(samplingRate !== undefined ? { samplingRate } : {}),
            },
          }
        : {}),
    };

    const handle = createOutputVerifierMiddleware(config);
    return handle.middleware;
  },
};

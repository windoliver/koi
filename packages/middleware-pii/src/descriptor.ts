/**
 * BrickDescriptor for @koi/middleware-pii.
 *
 * Enables manifest auto-resolution: the resolve layer validates
 * PII strategy/scope/hash options, then calls the factory.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createAllDetectors } from "./detectors.js";
import { createPIIMiddleware } from "./pii-middleware.js";
import type { PIIConfig, PIIStrategy } from "./types.js";

const VALID_STRATEGIES: readonly string[] = ["block", "redact", "mask", "hash"];

function validatePIIDescriptorOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "PII");
  if (!base.ok) return base;
  const opts = base.value;

  if (opts.strategy !== undefined && !VALID_STRATEGIES.includes(opts.strategy as string)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `pii.strategy must be one of: ${VALID_STRATEGIES.join(", ")}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.strategy === "hash" && typeof opts.hashSecret !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "pii.hashSecret is required when strategy is 'hash'",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for PII middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-pii",
  aliases: ["pii"],
  optionsValidator: validatePIIDescriptorOptions,
  factory(options): KoiMiddleware {
    const strategy = (
      typeof options.strategy === "string" ? options.strategy : "redact"
    ) as PIIStrategy;
    const hashSecret = typeof options.hashSecret === "string" ? options.hashSecret : undefined;

    const config: PIIConfig = {
      strategy,
      detectors: createAllDetectors(),
    };

    if (hashSecret !== undefined) {
      return createPIIMiddleware({ ...config, hashSecret });
    }

    return createPIIMiddleware(config);
  },
};

/**
 * BrickDescriptor for @koi/engine-pi.
 *
 * Enables manifest auto-resolution for the Pi agent engine.
 */

import type { EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createPiAdapter } from "./adapter.js";
import type { PiAdapterConfig } from "./types.js";

function validatePiEngineOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Pi engine options must be an object with a 'model' field",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = (input ?? {}) as Record<string, unknown>;

  if (typeof opts.model !== "string" || opts.model === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "pi.model is required (e.g., 'anthropic:claude-sonnet-4-5-20250929')",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for Pi engine adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-pi",
  aliases: ["pi"],
  optionsValidator: validatePiEngineOptions,
  factory(options): EngineAdapter {
    const model = options.model;
    if (typeof model !== "string") {
      throw new Error("pi.model is required");
    }

    const config: PiAdapterConfig = {
      model,
      ...(typeof options.systemPrompt === "string" ? { systemPrompt: options.systemPrompt } : {}),
    };

    return createPiAdapter(config);
  },
};

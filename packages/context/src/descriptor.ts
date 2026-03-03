/**
 * BrickDescriptor for @koi/context.
 *
 * Enables manifest auto-resolution for the context hydrator middleware.
 * Validates context sources configuration from the manifest.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import type { ContextSource } from "./types.js";

function isSourceArray(value: unknown): value is readonly ContextSource[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).kind === "string",
    )
  );
}

function validateContextDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Context");
  if (!base.ok) return base;
  const opts = base.value;

  if (opts.sources !== undefined && !isSourceArray(opts.sources)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "context.sources must be an array of source objects with a 'kind' field",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for context hydrator middleware.
 *
 * Note: The context hydrator requires an Agent instance and ContextManifestConfig
 * that cannot be resolved from YAML alone. The factory throws — the CLI must
 * inject runtime dependencies after resolution. This descriptor registers the
 * name/alias so the resolver can validate and locate it.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "context",
  name: "@koi/context",
  aliases: ["context"],
  optionsValidator: validateContextDescriptorOptions,
  factory(): KoiMiddleware {
    throw new Error(
      "@koi/context requires an Agent instance and ContextManifestConfig. " +
        "Use createContextHydrator(options) directly from the CLI.",
    );
  },
};

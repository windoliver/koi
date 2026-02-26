/**
 * BrickDescriptor for @koi/middleware-context-editing.
 *
 * Enables manifest auto-resolution: validates context-editing config,
 * then creates the context editing middleware.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createContextEditingMiddleware } from "./context-editing.js";
import type { ContextEditingConfig } from "./types.js";

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateContextEditingDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Context-editing options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.triggerTokenCount !== undefined &&
    (typeof opts.triggerTokenCount !== "number" || opts.triggerTokenCount <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "context-editing.triggerTokenCount must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.excludeTools !== undefined && !isStringArray(opts.excludeTools)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "context-editing.excludeTools must be an array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for context-editing middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-context-editing",
  aliases: ["context-editing"],
  optionsValidator: validateContextEditingDescriptorOptions,
  factory(options): KoiMiddleware {
    const config: Partial<ContextEditingConfig> = {};

    if (typeof options.triggerTokenCount === "number") {
      (config as { triggerTokenCount: number }).triggerTokenCount = options.triggerTokenCount;
    }
    if (typeof options.numRecentToKeep === "number") {
      (config as { numRecentToKeep: number }).numRecentToKeep = options.numRecentToKeep;
    }
    if (typeof options.clearToolCallInputs === "boolean") {
      (config as { clearToolCallInputs: boolean }).clearToolCallInputs =
        options.clearToolCallInputs;
    }
    if (isStringArray(options.excludeTools)) {
      (config as { excludeTools: readonly string[] }).excludeTools = options.excludeTools;
    }
    if (typeof options.placeholder === "string") {
      (config as { placeholder: string }).placeholder = options.placeholder;
    }

    return createContextEditingMiddleware(
      Object.keys(config).length > 0 ? (config as ContextEditingConfig) : undefined,
    );
  },
};

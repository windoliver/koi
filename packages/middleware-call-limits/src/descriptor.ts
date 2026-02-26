/**
 * BrickDescriptor for @koi/middleware-call-limits.
 *
 * Enables manifest auto-resolution: validates maxModelCalls/maxToolCalls
 * options, then creates model and/or tool call limit middleware.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createModelCallLimitMiddleware } from "./model-call-limit.js";
import { createInMemoryCallLimitStore } from "./store.js";
import { createToolCallLimitMiddleware } from "./tool-call-limit.js";

function validateCallLimitsDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Call limits options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.maxModelCalls !== undefined &&
    (typeof opts.maxModelCalls !== "number" || opts.maxModelCalls <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "call-limits.maxModelCalls must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.maxToolCalls !== undefined &&
    (typeof opts.maxToolCalls !== "number" || opts.maxToolCalls <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "call-limits.maxToolCalls must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.maxModelCalls === undefined && opts.maxToolCalls === undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "call-limits requires at least maxModelCalls or maxToolCalls",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for call-limits middleware.
 *
 * Creates a combined middleware that wraps both model and tool call limits.
 * Uses in-memory stores by default.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-call-limits",
  aliases: ["call-limits"],
  optionsValidator: validateCallLimitsDescriptorOptions,
  factory(options): KoiMiddleware {
    const maxModelCalls =
      typeof options.maxModelCalls === "number" ? options.maxModelCalls : undefined;
    const maxToolCalls =
      typeof options.maxToolCalls === "number" ? options.maxToolCalls : undefined;

    // If only model limits, return model middleware
    if (maxModelCalls !== undefined && maxToolCalls === undefined) {
      return createModelCallLimitMiddleware({
        limit: maxModelCalls,
        store: createInMemoryCallLimitStore(),
      });
    }

    // If only tool limits, return tool middleware
    if (maxToolCalls !== undefined && maxModelCalls === undefined) {
      return createToolCallLimitMiddleware({
        globalLimit: maxToolCalls,
        store: createInMemoryCallLimitStore(),
      });
    }

    // Both limits — compose into a single middleware wrapping both hooks
    const modelMw = createModelCallLimitMiddleware({
      limit: maxModelCalls as number,
      store: createInMemoryCallLimitStore(),
    });
    const toolMw = createToolCallLimitMiddleware({
      globalLimit: maxToolCalls as number,
      store: createInMemoryCallLimitStore(),
    });

    const combined: KoiMiddleware = {
      name: "call-limits",
      priority: 175,
      ...(modelMw.wrapModelCall !== undefined ? { wrapModelCall: modelMw.wrapModelCall } : {}),
      ...(toolMw.wrapToolCall !== undefined ? { wrapToolCall: toolMw.wrapToolCall } : {}),
    };
    return combined;
  },
};

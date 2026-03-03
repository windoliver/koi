/**
 * BrickDescriptor for @koi/middleware-compactor.
 *
 * Enables manifest auto-resolution: validates compactor config,
 * then creates the compactor middleware. Requires a resolved model
 * as the summarizer — falls back to the manifest's model section.
 */

import type { KoiError, KoiMiddleware, ModelHandler, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createCompactorMiddleware } from "./compactor-middleware.js";
import { createMemoryCompactionStore } from "./memory-compaction-store.js";

function validateCompactorDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Compactor");
  if (!base.ok) return base;
  const opts = base.value;

  if (
    opts.contextWindowSize !== undefined &&
    (typeof opts.contextWindowSize !== "number" || opts.contextWindowSize <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "compactor.contextWindowSize must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.preserveRecent !== undefined &&
    (typeof opts.preserveRecent !== "number" || opts.preserveRecent < 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "compactor.preserveRecent must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Creates a stub model handler that throws — compactor requires a real
 * summarizer to be provided at runtime or via manifest model resolution.
 */
function createStubSummarizer(): ModelHandler {
  return async () => {
    throw new Error(
      "Compactor middleware requires a model handler for summarization. " +
        "Configure a 'model' section in your manifest or provide a summarizer programmatically.",
    );
  };
}

/**
 * Descriptor for compactor middleware.
 * Uses in-memory compaction store and a stub summarizer by default.
 * The stub throws if invoked — the CLI should wire the resolved model.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-compactor",
  aliases: ["compactor"],
  optionsValidator: validateCompactorDescriptorOptions,
  factory(options, _context: ResolutionContext): KoiMiddleware {
    const contextWindowSize =
      typeof options.contextWindowSize === "number" ? options.contextWindowSize : undefined;
    const preserveRecent =
      typeof options.preserveRecent === "number" ? options.preserveRecent : undefined;

    const config: Parameters<typeof createCompactorMiddleware>[0] = {
      summarizer: createStubSummarizer(),
      store: createMemoryCompactionStore(),
    };

    const overrides: Record<string, unknown> = {};
    if (contextWindowSize !== undefined) {
      overrides.contextWindowSize = contextWindowSize;
    }
    if (preserveRecent !== undefined) {
      overrides.preserveRecent = preserveRecent;
    }

    return createCompactorMiddleware({ ...config, ...overrides } as Parameters<
      typeof createCompactorMiddleware
    >[0]);
  },
};

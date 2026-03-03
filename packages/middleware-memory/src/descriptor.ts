/**
 * BrickDescriptor for @koi/middleware-memory.
 *
 * Enables manifest auto-resolution: validates memory config,
 * then creates the memory middleware with an in-memory store by default.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createMemoryMiddleware } from "./memory.js";
import { createInMemoryStore } from "./store.js";

function validateMemoryDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Memory");
  if (!base.ok) return base;
  const opts = base.value;

  if (
    opts.maxRecallTokens !== undefined &&
    (typeof opts.maxRecallTokens !== "number" || opts.maxRecallTokens <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "memory.maxRecallTokens must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const validStrategies = ["recent", "relevant", "hybrid"];
  if (
    opts.recallStrategy !== undefined &&
    !validStrategies.includes(opts.recallStrategy as string)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `memory.recallStrategy must be one of: ${validStrategies.join(", ")}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for memory middleware.
 * Uses an in-memory store by default.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-memory",
  aliases: ["memory"],
  optionsValidator: validateMemoryDescriptorOptions,
  factory(options): KoiMiddleware {
    const store = createInMemoryStore();
    const maxRecallTokens =
      typeof options.maxRecallTokens === "number" ? options.maxRecallTokens : undefined;
    const recallStrategy =
      typeof options.recallStrategy === "string"
        ? (options.recallStrategy as "recent" | "relevant" | "hybrid")
        : undefined;

    const config: Parameters<typeof createMemoryMiddleware>[0] = { store };

    const overrides: Record<string, unknown> = {};
    if (maxRecallTokens !== undefined) {
      overrides.maxRecallTokens = maxRecallTokens;
    }
    if (recallStrategy !== undefined) {
      overrides.recallStrategy = recallStrategy;
    }

    return createMemoryMiddleware({ ...config, ...overrides } as Parameters<
      typeof createMemoryMiddleware
    >[0]);
  },
};

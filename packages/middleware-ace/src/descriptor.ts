/**
 * BrickDescriptor for @koi/middleware-ace.
 *
 * Enables manifest auto-resolution: validates ACE config,
 * then creates the ACE middleware with in-memory stores by default.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createAceMiddleware } from "./ace.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "./stores.js";

function validateAceDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ACE options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.maxInjectionTokens !== undefined &&
    (typeof opts.maxInjectionTokens !== "number" || opts.maxInjectionTokens <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ace.maxInjectionTokens must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for ACE middleware.
 * Uses in-memory trajectory and playbook stores by default.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-ace",
  aliases: ["ace"],
  optionsValidator: validateAceDescriptorOptions,
  factory(options, _context): KoiMiddleware {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const maxInjectionTokens =
      typeof options.maxInjectionTokens === "number" ? options.maxInjectionTokens : undefined;

    const config: Parameters<typeof createAceMiddleware>[0] = {
      trajectoryStore,
      playbookStore,
    };

    if (maxInjectionTokens !== undefined) {
      return createAceMiddleware({ ...config, maxInjectionTokens });
    }

    return createAceMiddleware(config);
  },
};

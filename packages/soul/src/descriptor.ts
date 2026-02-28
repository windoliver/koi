/**
 * BrickDescriptor for @koi/soul.
 *
 * Enables manifest auto-resolution: the resolve layer looks up this
 * descriptor, validates soul/user options, and calls the factory.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import type { ContentInput, CreateSoulOptions } from "./config.js";
import { createSoulMiddleware } from "./soul.js";

/**
 * Validates soul descriptor options from the manifest.
 *
 * Accepts { soul?: ContentInput, user?: ContentInput } — basePath
 * is injected from context.manifestDir by the factory, not from YAML.
 */
function validateSoulDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Soul options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  // Validate soul field if present
  if (opts.soul !== undefined) {
    if (!isValidContentInput(opts.soul)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "soul must be a string or { path: string, maxTokens?: number }",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  // Validate user field if present
  if (opts.user !== undefined) {
    if (!isValidContentInput(opts.user)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "user must be a string or { path: string, maxTokens?: number }",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: input };
}

function isValidContentInput(value: unknown): value is ContentInput {
  if (typeof value === "string") return true;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.path !== "string") return false;
    if (obj.maxTokens !== undefined && (typeof obj.maxTokens !== "number" || obj.maxTokens <= 0)) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Descriptor for soul middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/soul",
  aliases: ["soul", "@koi/middleware-soul"],
  optionsValidator: validateSoulDescriptorOptions,
  async factory(options, context): Promise<KoiMiddleware> {
    const soul = isValidContentInput(options.soul) ? options.soul : undefined;
    const user = isValidContentInput(options.user) ? options.user : undefined;
    const createOptions: CreateSoulOptions = {
      soul,
      user,
      basePath: context.manifestDir,
    };
    return createSoulMiddleware(createOptions);
  },
};

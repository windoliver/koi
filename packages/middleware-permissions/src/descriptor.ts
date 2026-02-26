/**
 * BrickDescriptor for @koi/middleware-permissions.
 *
 * Enables manifest auto-resolution: the resolve layer looks up this
 * descriptor, validates allow/deny/ask options, and calls the factory.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import type { PermissionRules } from "./engine.js";
import { createPatternPermissionEngine } from "./engine.js";
import { createPermissionsMiddleware } from "./permissions.js";

/**
 * Validates permissions descriptor options from the manifest.
 *
 * Accepts { allow?: string[], deny?: string[], ask?: string[] } — the
 * simplified manifest format (not the full PermissionsMiddlewareConfig).
 */
function validatePermissionsDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Permissions options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  // Validate allow
  if (opts.allow !== undefined && !isStringArray(opts.allow)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "permissions.allow must be an array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Validate deny
  if (opts.deny !== undefined && !isStringArray(opts.deny)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "permissions.deny must be an array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Validate ask
  if (opts.ask !== undefined && !isStringArray(opts.ask)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "permissions.ask must be an array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Descriptor for permissions middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-permissions",
  aliases: ["permissions"],
  optionsValidator: validatePermissionsDescriptorOptions,
  factory(options, context): KoiMiddleware {
    const rules: PermissionRules = {
      allow: isStringArray(options.allow) ? options.allow : [],
      deny: isStringArray(options.deny) ? options.deny : [],
      ask: isStringArray(options.ask) ? options.ask : [],
    };

    const engine = createPatternPermissionEngine();

    // Build config — only include approvalHandler when present
    // (exactOptionalPropertyTypes forbids setting optional props to undefined)
    if (context.approvalHandler !== undefined) {
      return createPermissionsMiddleware({
        engine,
        rules,
        approvalHandler: { requestApproval: context.approvalHandler.requestApproval },
      });
    }

    return createPermissionsMiddleware({ engine, rules });
  },
};

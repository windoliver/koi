/**
 * BrickDescriptor for @koi/middleware-permissions.
 *
 * Enables manifest auto-resolution: the resolve layer looks up this
 * descriptor, validates allow/deny/ask options, and calls the factory.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import type { PermissionRules } from "./engine.js";
import { createPatternPermissionBackend } from "./engine.js";
import { createPermissionsMiddleware } from "./permissions.js";

/**
 * Validates permissions descriptor options from the manifest.
 *
 * Accepts { allow?: string[], deny?: string[], ask?: string[] } — the
 * simplified manifest format (not the full PermissionsMiddlewareConfig).
 */
function validatePermissionsDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Permissions");
  if (!base.ok) return base;
  const opts = base.value;

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

  return { ok: true, value: opts };
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
    // Fail fast on invalid types — the validator should have caught these,
    // but direct callers of createPatternPermissionBackend() may bypass it.
    // Silent coercion to [] would cause deny-all without any indication.
    if (options.allow !== undefined && !isStringArray(options.allow)) {
      throw new Error(
        `permissions.allow must be an array of strings, got ${typeof options.allow}. ` +
          'A typo like allow: "*" silently becomes deny-all.',
      );
    }
    if (options.deny !== undefined && !isStringArray(options.deny)) {
      throw new Error(`permissions.deny must be an array of strings, got ${typeof options.deny}`);
    }
    if (options.ask !== undefined && !isStringArray(options.ask)) {
      throw new Error(`permissions.ask must be an array of strings, got ${typeof options.ask}`);
    }

    const rules: PermissionRules = {
      allow: options.allow ?? [],
      deny: options.deny ?? [],
      ask: options.ask ?? [],
    };

    const backend = createPatternPermissionBackend({ rules });

    // Build config — only include approvalHandler when present
    // (exactOptionalPropertyTypes forbids setting optional props to undefined)
    if (context.approvalHandler !== undefined) {
      return createPermissionsMiddleware({
        backend,
        approvalHandler: { requestApproval: context.approvalHandler.requestApproval },
      });
    }

    return createPermissionsMiddleware({ backend });
  },
};

/**
 * BrickDescriptor for @koi/filesystem.
 *
 * Enables manifest auto-resolution: the resolve layer looks up this
 * descriptor, validates filesystem options, and calls the factory.
 *
 * The factory always throws because @koi/filesystem requires a
 * FileSystemBackend instance that cannot be constructed from YAML alone.
 */

import type { ComponentProvider, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { OPERATIONS } from "./constants.js";

function validateFilesystemDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateOptionalDescriptorOptions(input, "Filesystem");
  if (!base.ok) return base;
  const opts = base.value;

  // Validate operations
  if (opts.operations !== undefined) {
    if (!Array.isArray(opts.operations)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "filesystem.operations must be an array",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    for (const op of opts.operations) {
      if (!(OPERATIONS as readonly string[]).includes(op as string)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `filesystem.operations contains invalid operation "${String(op)}". Valid: ${OPERATIONS.join(", ")}`,
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  // Validate prefix
  if (opts.prefix !== undefined && typeof opts.prefix !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "filesystem.prefix must be a string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Validate policy (must be an object with sandbox boolean)
  if (opts.policy !== undefined) {
    const p = opts.policy as Record<string, unknown>;
    if (typeof p !== "object" || p === null || typeof p.sandbox !== "boolean") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "filesystem.policy must be a ToolPolicy object with a 'sandbox' boolean field",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for filesystem provider.
 *
 * The factory always throws because a FileSystemBackend instance is
 * required — use `createFileSystemProvider({ backend })` directly.
 */
export const descriptor: BrickDescriptor<ComponentProvider> = {
  kind: "tool",
  name: "@koi/filesystem",
  aliases: ["filesystem", "fs"],
  optionsValidator: validateFilesystemDescriptorOptions,
  factory(_options, _context): ComponentProvider {
    throw new Error(
      "@koi/filesystem requires a FileSystemBackend. Use createFileSystemProvider({ backend }) directly.",
    );
  },
};

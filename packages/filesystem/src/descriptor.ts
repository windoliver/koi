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

const TRUST_TIERS = ["sandbox", "verified", "promoted"] as const;

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

  // Validate trustTier
  if (opts.trustTier !== undefined) {
    if (!(TRUST_TIERS as readonly string[]).includes(opts.trustTier as string)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `filesystem.trustTier must be one of: ${TRUST_TIERS.join(", ")}`,
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
